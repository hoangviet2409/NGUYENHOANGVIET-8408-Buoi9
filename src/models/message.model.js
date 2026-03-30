const mongoose = require("mongoose");

const { Schema } = mongoose;

const messageSchema = new Schema(
  {
    from: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    to: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    clientMessageId: {
      type: String,
      trim: true,
      maxlength: 100,
      default: null,
    },
    contentMessage: {
      type: {
        type: String,
        enum: ["file", "text"],
        required: true,
      },
      content: {
        type: String,
        required: true,
        trim: true,
      },
    },
    isRead: {
      type: Boolean,
      default: false,
      index: true,
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

messageSchema.index({ from: 1, to: 1, createdAt: -1 });
messageSchema.index({ to: 1, from: 1, createdAt: -1 });
messageSchema.index({ to: 1, isRead: 1, createdAt: -1 });
messageSchema.index(
  { from: 1, clientMessageId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      clientMessageId: { $type: "string" },
    },
  },
);

module.exports = mongoose.model("Message", messageSchema);
