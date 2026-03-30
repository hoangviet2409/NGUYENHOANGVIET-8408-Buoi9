const USER_ROOM_PREFIX = "user:";

function getUserRoom(userId) {
  return `${USER_ROOM_PREFIX}${userId}`;
}

function toIdString(value) {
  if (value && typeof value === "object" && value._id) {
    return String(value._id);
  }

  return String(value);
}

function registerMessageSocket(io, authenticateSocket) {
  if (io.__messageSocketRegistered) {
    return;
  }

  if (typeof authenticateSocket !== "function") {
    throw new Error("registerMessageSocket requires an authenticateSocket function");
  }

  io.__messageSocketRegistered = true;

  io.use(async (socket, next) => {
    try {
      const user = await authenticateSocket(socket);

      if (!user || !user._id) {
        return next(new Error("Unauthorized"));
      }

      socket.user = {
        _id: String(user._id),
      };

      return next();
    } catch (error) {
      return next(error);
    }
  });

  io.on("connection", (socket) => {
    const userId = socket.user._id;

    socket.join(getUserRoom(userId));
    socket.emit("socket:ready", { userId });
  });
}

function emitNewMessage(io, messageDocument) {
  if (!io || !messageDocument) {
    return;
  }

  const payload =
    typeof messageDocument.toObject === "function"
      ? messageDocument.toObject()
      : messageDocument;

  const senderId = toIdString(payload.from);
  const receiverId = toIdString(payload.to);

  io.to(getUserRoom(senderId)).emit("message:sent", payload);
  io.to(getUserRoom(receiverId)).emit("message:new", payload);

  io.to(getUserRoom(senderId)).emit("conversation:updated", payload);
  io.to(getUserRoom(receiverId)).emit("conversation:updated", payload);
}

function emitMessagesRead(io, payload) {
  if (!io || !payload) {
    return;
  }

  const readerId = toIdString(payload.readerId);
  const partnerId = toIdString(payload.partnerId);

  io.to(getUserRoom(readerId)).emit("message:read", payload);
  io.to(getUserRoom(partnerId)).emit("message:read", payload);
  io.to(getUserRoom(readerId)).emit("conversation:updated", payload);
  io.to(getUserRoom(partnerId)).emit("conversation:updated", payload);
}

module.exports = {
  emitNewMessage,
  emitMessagesRead,
  getUserRoom,
  registerMessageSocket,
};
