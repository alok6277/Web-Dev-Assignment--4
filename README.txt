ORBItCHAT - NEW INDEPENDENT CHAT APPLICATION

Features
- Real-time Global Chat
- Create private room with a unique room code
- Join a private room using its code
- Online user count
- Responsive dark interface

Requirements: Node.js 18+

Run in VS Code terminal:
1. Open this OrbitChat-New folder.
2. Run: npm install
3. Run: npm start
4. Open: http://localhost:8080
5. Open the same URL in another browser/device to test multi-user chat.

This project is separate from the previously uploaded day2 project. It uses Express + Socket.IO.
Room membership and messages are kept in server memory; rooms disappear when their last member leaves or the server restarts. This starter does not include persistent chat history or authentication.
