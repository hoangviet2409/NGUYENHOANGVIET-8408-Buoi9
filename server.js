const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const { Server } = require("socket.io");
const { registerMessageModule } = require("./src/chat/register-message-module");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// 1. Kết nối MongoDB cục bộ
mongoose.connect("mongodb://localhost:27017/chat_app_test")
  .then(() => console.log("✅ Đã kết nối MongoDB"))
  .catch(err => console.error("❌ Lỗi kết nối DB:", err));

// 2. Mock Middleware Xác thực
const authMiddleware = (req, res, next) => {
  const userId = req.headers["x-user-id"] || "65b8dfaaaaaa111122223333";
  req.user = { _id: userId };
  next();
};

// 3. Mock Xác thực Socket
const authenticateSocket = async (socket) => {
  const userId = socket.handshake.query.userId || "65b8dfaaaaaa111122223333";
  return { _id: userId };
};

// 4. Mock Check User
const userExists = async (userId) => true; 

// 5. Khởi chạy Module Messaging
registerMessageModule({
  app,
  io,
  authMiddleware,
  authenticateSocket,
  routerPath: "/api/messages",
  userExists
});

const PORT = 3000;
server.listen(PORT, () => {
  console.log(`🚀 Server đang chạy tại http://localhost:${PORT}`);
});
