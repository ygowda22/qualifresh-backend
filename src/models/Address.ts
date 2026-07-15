import mongoose, { Schema, Document } from "mongoose";

export interface IAddress extends Document {
  userId: mongoose.Types.ObjectId;
  label: string;
  line1: string;
  city: string;
  pincode?: string;
}

const AddressSchema = new Schema<IAddress>(
  {
    userId:  { type: Schema.Types.ObjectId, ref: "User", required: true },
    label:   { type: String, default: "Home" },
    line1:   { type: String, required: true },
    city:    { type: String, required: true },
    pincode: { type: String },
  },
  { timestamps: true }
);

export const Address =
  mongoose.models.Address || mongoose.model<IAddress>("Address", AddressSchema);
