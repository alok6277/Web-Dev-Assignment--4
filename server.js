
require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 8081;

// ==============================
// MIDDLEWARE
// ==============================

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// ==============================
// SESSION
// ==============================

if (!process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET missing in .env");
}

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

// ==============================
// PASSPORT
// ==============================

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((user, done) => {
  done(null, user);
});

// ==============================
// GOOGLE OAUTH
// ==============================

if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL:
          process.env.GOOGLE_CALLBACK_URL ||
          `http://localhost:${PORT}/auth/google/callback`
      },
      (accessToken, refreshToken, googleProfile, done) => {
        const email = googleProfile.emails?.[0]?.value;

        if (!email) {
          return done(new Error("Google email not available"));
        }

        done(null, {
          name: googleProfile.displayName || "Google User",
          email: email.toLowerCase(),
          provider: "google",
          googleId: googleProfile.id
        });
      }
    )
  );
} else {
  console.warn("Google OAuth credentials are missing.");
}

// ==============================
// GOOGLE LOGIN ROUTES
// ==============================

app.get("/auth/google", (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID ||
      !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).send("Google OAuth is not configured.");
  }

  passport.authenticate("google", {
    scope: ["profile", "email"],
    prompt: "select_account"
  })(req, res, next);
});

app.get(
  "/auth/google/callback",
  passport.authenticate("google", {
    failureRedirect: "/?login=failed"
  }),
  (req, res, next) => {
    req.session.user = {
      name: req.user.name,
      email: req.user.email,
      provider: "google",
      googleId: req.user.googleId
    };

    req.session.save((error) => {
      if (error) return next(error);
      res.redirect("/");
    });
  }
);

// ==============================
// NAME + EMAIL LOGIN
// ==============================

app.post("/auth/guest", (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();

  if (!name || name.length > 40) {
    return res.status(400).json({
      message: "Enter a valid name (maximum 40 characters)."
    });
  }

  if (
    !email ||
    email.length > 100 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({
      message: "Enter a valid email address."
    });
  }

  req.session.user = {
    name,
    email,
    provider: "guest"
  };

  req.session.save((error) => {
    if (error) {
      console.error(error);

      return res.status(500).json({
        message: "Login session could not be created."
      });
    }

    res.json({
      success: true,
      user: req.session.user
    });
  });
});

// ==============================
// CHECK LOGIN
// ==============================

app.get("/api/me", (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({
      message: "Not logged in"
    });
  }

  res.json({
    user: req.session.user
  });
});

// ==============================
// LOGOUT
// ==============================

app.post("/auth/logout", (req, res) => {
  req.session.destroy((error) => {
    if (error) {
      return res.status(500).json({
        message: "Logout failed"
      });
    }

    res.clearCookie("connect.sid");

    res.json({
      success: true
    });
  });
});

// ==============================
// HEALTH CHECK
// ==============================

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    message: "OrbitChat server is running"
  });
});

// ==============================
// SOCKET.IO SESSION
// ==============================

io.engine.use(sessionMiddleware);

io.use((socket, next) => {
  const user = socket.request.session?.user;

  if (!user) {
    return next(new Error("Please login first"));
  }

  socket.data.user = user;
  next();
});

// ==============================
// IN-MEMORY DATA
// ==============================

const rooms = new Map();
const users = new Map();

function generateRoomId() {
  let roomId;

  do {
    const code = Math.random()
      .toString(36)
      .substring(2, 6)
      .toUpperCase();

    roomId = `NX-${code}-123`;
  } while (rooms.has(roomId));

  return roomId;
}

function getRoomMembers(roomId) {
  const room = rooms.get(roomId);

  if (!room) return [];

  return [...room.members]
    .map((socketId) => {
      const member = users.get(socketId);

      if (!member) return null;

      return {
        name: member.name,
        email: member.email
      };
    })
    .filter(Boolean);
}

function sendRoomMembers(roomId) {
  if (!rooms.has(roomId)) return;

  io.to(roomId).emit(
    "room-members",
    getRoomMembers(roomId)
  );
}

// ==============================
// LEAVE CURRENT ROOM
// ==============================

function leaveCurrentRoom(socket) {
  const roomId = socket.data.currentRoom;

  if (!roomId) return;

  const room = rooms.get(roomId);

  socket.leave(roomId);
  socket.data.currentRoom = null;

  if (room) {
    room.members.delete(socket.id);

    socket.to(roomId).emit(
      "room-notice",
      `${socket.data.user.name} left the room.`
    );

    if (room.members.size === 0) {
      rooms.delete(roomId);
    } else {
      sendRoomMembers(roomId);
    }
  }

  socket.emit("room-left");
}

// ==============================
// SOCKET CONNECTION
// ==============================

io.on("connection", (socket) => {
  const user = socket.data.user;

  users.set(socket.id, {
    name: user.name,
    email: user.email,
    provider: user.provider
  });

  console.log(`${user.name} connected`);

  io.emit("online-count", users.size);

  socket.emit("server-ready", {
    user: {
      name: user.name,
      email: user.email
    },
    online: users.size
  });

  // ============================
  // GLOBAL CHAT
  // ============================

  socket.on("global-message", (message) => {
    const text =
      typeof message === "string"
        ? message.trim()
        : "";

    if (!text || text.length > 2000) return;

    io.emit("global-message", {
      name: user.name,
      email: user.email,
      text,
      time: new Date().toISOString(),
      socketId: socket.id
    });
  });

  // ============================
  // CREATE PRIVATE ROOM
  // ============================

  socket.on("create-room", (data = {}, callback) => {
    try {
      leaveCurrentRoom(socket);

      const roomId = generateRoomId();

      const roomName =
        String(data?.roomName || "Private Room")
          .trim()
          .slice(0, 40) || "Private Room";

      rooms.set(roomId, {
        name: roomName,
        members: new Set()
      });

      const room = rooms.get(roomId);

      room.members.add(socket.id);

      socket.join(roomId);
      socket.data.currentRoom = roomId;

      const result = {
        ok: true,
        roomId,
        roomName
      };

      socket.emit("room-created", result);

      sendRoomMembers(roomId);

      if (typeof callback === "function") {
        callback(result);
      }

      console.log(`${user.name} created ${roomId}`);
    } catch (error) {
      console.error("Create room error:", error);

      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Could not create room."
        });
      }
    }
  });

  // ============================
  // JOIN PRIVATE ROOM
  // ============================

  socket.on("join-room", (roomCode, callback) => {
    try {
      const roomId =
        typeof roomCode === "string"
          ? roomCode.trim().toUpperCase()
          : "";

      if (!roomId || !rooms.has(roomId)) {
        if (typeof callback === "function") {
          callback({
            ok: false,
            error: "Room not found. Check the room code."
          });
        }

        return;
      }

      leaveCurrentRoom(socket);

      const room = rooms.get(roomId);

      room.members.add(socket.id);

      socket.join(roomId);
      socket.data.currentRoom = roomId;

      const result = {
        ok: true,
        roomId,
        roomName: room.name
      };

      socket.emit("room-joined", result);

      socket.to(roomId).emit(
        "room-notice",
        `${user.name} joined the room.`
      );

      sendRoomMembers(roomId);

      if (typeof callback === "function") {
        callback(result);
      }

      console.log(`${user.name} joined ${roomId}`);
    } catch (error) {
      console.error("Join room error:", error);

      if (typeof callback === "function") {
        callback({
          ok: false,
          error: "Could not join room."
        });
      }
    }
  });

  // ============================
  // PRIVATE ROOM MESSAGE
  // ============================

  socket.on("room-message", (message) => {
    const roomId = socket.data.currentRoom;

    const text =
      typeof message === "string"
        ? message.trim()
        : "";

    if (!roomId || !rooms.has(roomId)) return;
    if (!text || text.length > 2000) return;

    io.to(roomId).emit("room-message", {
      name: user.name,
      email: user.email,
      text,
      time: new Date().toISOString(),
      socketId: socket.id
    });
  });

  // ============================
  // LEAVE ROOM
  // ============================

  socket.on("leave-room", () => {
    leaveCurrentRoom(socket);
  });

  // ============================
  // DISCONNECT
  // ============================

  socket.on("disconnect", () => {
    leaveCurrentRoom(socket);

    users.delete(socket.id);

    io.emit("online-count", users.size);

    console.log(`${user.name} disconnected`);
  });
});

// ==============================
// START SERVER
// ==============================

server.listen(PORT, () => {
  console.log("--------------------------------");
  console.log("OrbitChat server is running");
  console.log(`http://localhost:${PORT}`);
  console.log("--------------------------------");
});
