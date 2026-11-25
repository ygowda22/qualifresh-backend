import mongoose, { Schema, Document } from "mongoose";

export interface IOrderItem {
  productId: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  quantity: number;
  price: number;
}

export interface IOrder extends Document {
  orderNumber: string;
  user?: mongoose.Types.ObjectId;
  guestName?: string;
  guestEmail?: string;
  guestPhone?: string;
  items: IOrderItem[];
  subtotal: number;
  deliveryCharge: number;
  total: number;
  deliveryAddress: string;
  city: string;
  deliverySlot: string;
  notes?: string;
  status: "pending" | "confirmed" | "out_for_delivery" | "delivered" | "cancelled";
  source: "website" | "whatsapp";
  createdAt: Date;
  editHistory?: IOrderEdit[];
}

// Backend-only audit of admin item edits. select:false keeps it out of every query result,
// so no API response (admin list, My Orders, …) ever contains it. Older orders simply have none.
export interface IOrderEdit {
  editedAt: Date;
  editedBy: string;
  before: { items: IOrderItem[]; subtotal: number; deliveryCharge: number; total: number };
  after: { items: IOrderItem[]; subtotal: number; deliveryCharge: number; total: number };
}

const OrderItemSchema = new Schema<IOrderItem>({
  productId: { type: Schema.Types.ObjectId, ref: "Product" },
  name:      { type: String, required: true },
  slug:      { type: String, required: true },
  quantity:  { type: Number, required: true, min: 1 },
  price:     { type: Number, required: true },
});

const OrderSchema = new Schema<IOrder>(
  {
    orderNumber:    { type: String, unique: true },
    user:           { type: Schema.Types.ObjectId, ref: "User" },
    guestName:      { type: String },
    guestEmail:     { type: String },
    guestPhone:     { type: String },
    items:          [OrderItemSchema],
    subtotal:       { type: Number, required: true },
    deliveryCharge: { type: Number, required: true, default: 0 },
    total:          { type: Number, required: true },
    deliveryAddress:{ type: String, required: true },
    city:           { type: String, required: true },
    deliverySlot:   { type: String, required: true },
    notes:          { type: String },
    status:         { type: String, enum: ["pending","confirmed","out_for_delivery","delivered","cancelled"], default: "pending" },
    source:         { type: String, enum: ["website","whatsapp"], default: "website" },
    editHistory:    { type: [{ _id: false, editedAt: Date, editedBy: String, before: Schema.Types.Mixed, after: Schema.Types.Mixed }], select: false, default: undefined },
  },
  { timestamps: true }
);

async function getNextOrderNumber(): Promise<string> {
  const db = mongoose.connection.db!;
  const counter = await db.collection<{ _id: string; seq: number }>("counters").findOneAndUpdate(
    { _id: "orderNumber" },
    { $inc: { seq: 1 } },
    { returnDocument: "after", upsert: true }
  );
  return `QF-${counter!.seq}`;
}

OrderSchema.pre("save", async function (next) {
  if (!this.orderNumber) {
    this.orderNumber = await getNextOrderNumber();
  }
  next();
});

export const Order =
  mongoose.models.Order || mongoose.model<IOrder>("Order", OrderSchema);
