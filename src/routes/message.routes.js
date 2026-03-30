const express = require("express");
const mongoose = require("mongoose");

const Message = require("../models/message.model");
const { emitMessagesRead, emitNewMessage } = require("../socket/message.socket");

const router = express.Router();
const MAX_TEXT_LENGTH = 5000;
const MAX_FILE_URL_LENGTH = 2048;
const MAX_PAGE_SIZE = 100;
const MAX_READ_BATCH = 200;
const MAX_FULL_FETCH = 1000;

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseObjectId(value, fieldName) {
  if (!mongoose.Types.ObjectId.isValid(value)) {
    throw createHttpError(400, `${fieldName} is invalid`);
  }

  return new mongoose.Types.ObjectId(value);
}

function getCurrentUserId(req) {
  const userId = req.user?._id || req.user?.id;

  if (!userId) {
    throw createHttpError(401, "Unauthorized");
  }

  return String(userId);
}

function getUserModel(req) {
  const configuredModel = reqSafeGetAppValue(req, "UserModel");
  if (configuredModel && typeof configuredModel.exists === "function") {
    return configuredModel;
  }

  return mongoose.models.User || null;
}

function reqSafeGetAppValue(req, key) {
  if (!req || !req.app || typeof req.app.get !== "function") {
    return null;
  }

  try {
    return req.app.get(key);
  } catch (error) {
    return null;
  }
}

async function ensureUserExists(req, userObjectId, fieldName) {
  const userExists = reqSafeGetAppValue(req, "userExists");

  if (typeof userExists === "function") {
    const exists = await userExists(String(userObjectId));

    if (!exists) {
      throw createHttpError(404, `${fieldName} does not exist`);
    }

    return;
  }

  const findUserById = reqSafeGetAppValue(req, "findUserById");

  if (typeof findUserById === "function") {
    const user = await findUserById(String(userObjectId));

    if (!user) {
      throw createHttpError(404, `${fieldName} does not exist`);
    }

    return;
  }

  const User = getUserModel(req);

  if (!User) {
    throw createHttpError(
      500,
      "User lookup is not configured. Set app.set('userExists', fn), app.set('findUserById', fn), or app.set('UserModel', UserModel)",
    );
  }

  const exists = await User.exists({ _id: userObjectId });

  if (!exists) {
    throw createHttpError(404, `${fieldName} does not exist`);
  }
}

function getPagination(query) {
  const rawPage = Math.max(Number.parseInt(query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(Number.parseInt(query.limit, 10) || 50, 1), MAX_PAGE_SIZE);
  const fetchAll = query.all === "true";
  const beforeMessageId =
    typeof query.beforeMessageId === "string" && query.beforeMessageId.trim()
      ? query.beforeMessageId.trim()
      : null;
  const before = typeof query.before === "string" ? new Date(query.before) : null;

  if (beforeMessageId && !mongoose.Types.ObjectId.isValid(beforeMessageId)) {
    throw createHttpError(400, "beforeMessageId is invalid");
  }

  if (before && Number.isNaN(before.getTime())) {
    throw createHttpError(400, "before must be a valid ISO date");
  }

  return {
    beforeMessageId,
    before,
    page: before || beforeMessageId ? 1 : rawPage,
    limit,
    fetchAll,
    usesCursor: Boolean(before || beforeMessageId),
  };
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}

function normalizeClientMessageId(body) {
  const clientMessageId =
    typeof body?.clientMessageId === "string" ? body.clientMessageId.trim() : "";

  if (!clientMessageId) {
    return null;
  }

  if (clientMessageId.length > 100) {
    throw createHttpError(400, "clientMessageId must be at most 100 characters");
  }

  return clientMessageId;
}

function normalizeReadMessageIds(body) {
  if (!Array.isArray(body?.messageIds)) {
    return null;
  }

  if (body.messageIds.length === 0) {
    return [];
  }

  if (body.messageIds.length > MAX_READ_BATCH) {
    throw createHttpError(400, `messageIds cannot exceed ${MAX_READ_BATCH} items`);
  }

  return body.messageIds.map((value) => parseObjectId(value, "messageIds"));
}

function normalizeContentMessage(body) {
  const hasStructuredPayload = body?.contentMessage !== undefined;
  const hasShortcutPayload = Boolean(body?.content) || Boolean(body?.fileUrl);

  if (hasStructuredPayload && hasShortcutPayload) {
    throw createHttpError(
      400,
      "Use either contentMessage or content/fileUrl, not both",
    );
  }

  if (hasStructuredPayload) {
    const type =
      typeof body.contentMessage?.type === "string"
        ? body.contentMessage.type.trim()
        : "";
    const content =
      typeof body.contentMessage?.content === "string"
        ? body.contentMessage.content.trim()
        : "";

    if (!["file", "text"].includes(type) || !content) {
      throw createHttpError(
        400,
        "contentMessage must include a valid type and non-empty content",
      );
    }

    if (type === "text" && content.length > MAX_TEXT_LENGTH) {
      throw createHttpError(400, `text content must be at most ${MAX_TEXT_LENGTH} characters`);
    }

    if (type === "file") {
      if (content.length > MAX_FILE_URL_LENGTH) {
        throw createHttpError(400, `file URL must be at most ${MAX_FILE_URL_LENGTH} characters`);
      }

      if (!isHttpUrl(content)) {
        throw createHttpError(400, "file content must be a valid http/https URL");
      }
    }

    return { type, content };
  }

  const textContent =
    typeof body?.content === "string" ? body.content.trim() : "";
  const fileUrl = typeof body?.fileUrl === "string" ? body.fileUrl.trim() : "";

  if (textContent && fileUrl) {
    throw createHttpError(400, "Send either content or fileUrl, not both");
  }

  if (!textContent && !fileUrl) {
    throw createHttpError(400, "content or fileUrl is required");
  }

  if (fileUrl) {
    if (fileUrl.length > MAX_FILE_URL_LENGTH) {
      throw createHttpError(400, `fileUrl must be at most ${MAX_FILE_URL_LENGTH} characters`);
    }

    if (!isHttpUrl(fileUrl)) {
      throw createHttpError(400, "fileUrl must be a valid http/https URL");
    }

    return {
      type: "file",
      content: fileUrl,
    };
  }

  if (textContent.length > MAX_TEXT_LENGTH) {
    throw createHttpError(400, `content must be at most ${MAX_TEXT_LENGTH} characters`);
  }

  return {
    type: "text",
    content: textContent,
  };
}

router.get("/", async (req, res, next) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const currentUserObjectId = parseObjectId(currentUserId, "currentUserId");
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 50, 1),
      MAX_PAGE_SIZE,
    );

    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [{ from: currentUserObjectId }, { to: currentUserObjectId }],
        },
      },
      {
        $addFields: {
          peerId: {
            $cond: [{ $eq: ["$from", currentUserObjectId] }, "$to", "$from"],
          },
        },
      },
      {
        $sort: {
          createdAt: -1,
          _id: -1,
        },
      },
      {
        $group: {
          _id: "$peerId",
          lastMessage: { $first: "$$ROOT" },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [
                    { $eq: ["$to", currentUserObjectId] },
                    { $eq: ["$isRead", false] },
                  ],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $sort: {
          "lastMessage.createdAt": -1,
          "lastMessage._id": -1,
        },
      },
      {
        $limit: limit,
      },
    ]);

    return res.status(200).json({
      data: conversations.map((item) => ({
        userId: String(item._id),
        lastMessage: item.lastMessage,
        unreadCount: item.unreadCount,
      })),
      pagination: {
        limit,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/:userId", async (req, res, next) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const peerUserId = req.params.userId;
    const {
      before,
      beforeMessageId,
      fetchAll,
      limit,
      page,
      usesCursor,
    } = getPagination(req.query);

    const currentUserObjectId = parseObjectId(currentUserId, "currentUserId");
    const peerUserObjectId = parseObjectId(peerUserId, "userId");

    await ensureUserExists(req, peerUserObjectId, "userId");

    const conversationFilter = {
      $or: [
        {
          from: currentUserObjectId,
          to: peerUserObjectId,
        },
        {
          from: peerUserObjectId,
          to: currentUserObjectId,
        },
      ],
    };

    let filter = conversationFilter;

    if (beforeMessageId) {
      const cursorMessage = await Message.findOne({
        _id: parseObjectId(beforeMessageId, "beforeMessageId"),
        ...conversationFilter,
      })
        .select("_id createdAt")
        .lean();

      if (!cursorMessage) {
        throw createHttpError(400, "beforeMessageId does not belong to this conversation");
      }

      filter = {
        $and: [
          conversationFilter,
          {
            $or: [
              { createdAt: { $lt: cursorMessage.createdAt } },
              {
                createdAt: cursorMessage.createdAt,
                _id: { $lt: cursorMessage._id },
              },
            ],
          },
        ],
      };
    } else if (before) {
      filter = {
        $and: [
          conversationFilter,
          {
            createdAt: { $lt: before },
          },
        ],
      };
    }

    const sort = { createdAt: -1, _id: -1 };

    if (fetchAll) {
      const total = await Message.countDocuments(filter);

      if (total > MAX_FULL_FETCH) {
        throw createHttpError(
          400,
          `Conversation is too large for all=true. Use pagination or before cursor. Maximum full fetch is ${MAX_FULL_FETCH} messages`,
        );
      }

      const messages = await Message.find(filter).sort(sort).lean();

      return res.status(200).json({
        data: messages.reverse(),
        pagination: null,
      });
    }

    if (usesCursor) {
      const messages = await Message.find(filter).sort(sort).limit(limit).lean();
      const nextBefore =
        messages.length > 0 ? messages[messages.length - 1].createdAt : null;
      const nextBeforeMessageId =
        messages.length > 0 ? String(messages[messages.length - 1]._id) : null;

      return res.status(200).json({
        data: messages.reverse(),
        pagination: {
          limit,
          hasMore: messages.length === limit,
          nextBefore,
          nextBeforeMessageId,
          mode: "cursor",
        },
      });
    }

    const [messages, total] = await Promise.all([
      Message.find(filter)
        .sort(sort)
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Message.countDocuments(filter),
    ]);

    const nextBefore =
      messages.length > 0 ? messages[messages.length - 1].createdAt : null;
    const nextBeforeMessageId =
      messages.length > 0 ? String(messages[messages.length - 1]._id) : null;

    return res.status(200).json({
      data: messages.reverse(),
      pagination: {
        page,
        limit,
        total,
        hasMore: page * limit < total,
        nextBefore,
        nextBeforeMessageId,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const currentUserObjectId = parseObjectId(currentUserId, "currentUserId");
    const receiverId = req.body?.to;
    const receiverObjectId = parseObjectId(receiverId, "to");
    const clientMessageId = normalizeClientMessageId(req.body);

    if (String(currentUserObjectId) === String(receiverObjectId)) {
      throw createHttpError(400, "Cannot send message to yourself");
    }

    await ensureUserExists(req, receiverObjectId, "to");

    const contentMessage = normalizeContentMessage(req.body);

    if (clientMessageId) {
      const existingMessage = await Message.findOne({
        from: currentUserObjectId,
        clientMessageId,
      }).lean();

      if (existingMessage) {
        return res.status(200).json({
          data: existingMessage,
          deduplicated: true,
        });
      }
    }

    let message;

    try {
      message = await Message.create({
        from: currentUserObjectId,
        to: receiverObjectId,
        clientMessageId,
        contentMessage,
      });
    } catch (error) {
      if (error?.code === 11000 && clientMessageId) {
        const existingMessage = await Message.findOne({
          from: currentUserObjectId,
          clientMessageId,
        }).lean();

        if (existingMessage) {
          return res.status(200).json({
            data: existingMessage,
            deduplicated: true,
          });
        }
      }

      throw error;
    }

    const io = req.app.get("io");
    emitNewMessage(io, message);

    return res.status(201).json({
      data: message,
    });
  } catch (error) {
    return next(error);
  }
});

router.patch("/:userId/read", async (req, res, next) => {
  try {
    const currentUserId = getCurrentUserId(req);
    const peerUserId = req.params.userId;
    const selectedMessageIds = normalizeReadMessageIds(req.body);

    const currentUserObjectId = parseObjectId(currentUserId, "currentUserId");
    const peerUserObjectId = parseObjectId(peerUserId, "userId");

    await ensureUserExists(req, peerUserObjectId, "userId");

    const unreadFilter = {
      from: peerUserObjectId,
      to: currentUserObjectId,
      isRead: false,
    };

    if (selectedMessageIds) {
      unreadFilter._id = { $in: selectedMessageIds };
    }

    const unreadMessages = await Message.find(unreadFilter)
      .select("_id")
      .sort({ createdAt: 1, _id: 1 })
      .lean();

    if (unreadMessages.length === 0) {
      return res.status(200).json({
        data: {
          updatedCount: 0,
          messageIds: [],
        },
      });
    }

    const messageIds = unreadMessages.map((item) => item._id);
    const readAt = new Date();

    await Message.updateMany(
      { _id: { $in: messageIds } },
      {
        $set: {
          isRead: true,
          readAt,
        },
      },
    );

    const io = req.app.get("io");
    emitMessagesRead(io, {
      messageIds: messageIds.map((item) => String(item)),
      readerId: currentUserObjectId,
      partnerId: peerUserObjectId,
      readAt,
    });

    return res.status(200).json({
      data: {
        updatedCount: messageIds.length,
        messageIds: messageIds.map((item) => String(item)),
        readAt,
      },
    });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
