const messageRoutes = require("../routes/message.routes");
const { registerMessageSocket } = require("../socket/message.socket");

function assertFunction(value, fieldName) {
  if (typeof value !== "function") {
    throw new Error(`${fieldName} must be a function`);
  }
}

function registerMessageModule({
  app,
  io,
  authMiddleware,
  authenticateSocket,
  routerPath = "/messages",
  userExists,
  findUserById,
  UserModel,
}) {
  if (!app || typeof app.use !== "function" || typeof app.set !== "function") {
    throw new Error("app must be an Express application");
  }

  if (!io) {
    throw new Error("io is required");
  }

  assertFunction(authMiddleware, "authMiddleware");
  assertFunction(authenticateSocket, "authenticateSocket");

  if (!userExists && !findUserById && !UserModel) {
    throw new Error("Provide userExists, findUserById, or UserModel");
  }

  app.set("io", io);

  if (typeof userExists === "function") {
    app.set("userExists", userExists);
  }

  if (typeof findUserById === "function") {
    app.set("findUserById", findUserById);
  }

  if (UserModel && typeof UserModel.exists === "function") {
    app.set("UserModel", UserModel);
  }

  app.use(routerPath, authMiddleware, messageRoutes);
  registerMessageSocket(io, authenticateSocket);

  return {
    routerPath,
  };
}

module.exports = {
  registerMessageModule,
};
