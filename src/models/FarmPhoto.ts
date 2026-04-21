import mongoose, { Schema, Document } from "mongoose";

export interface IFarmPhoto extends Document {
  title:       string;
  description: string;
  imageUrl:    string;
  order:       number;
}

const FarmPhotoSchema = new Schema<IFarmPhoto>(
  {
    title:       { type: String, default: "" },
    description: { type: String, default: "" },
    imageUrl:    { type: String, required: true },
    order:       { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const FarmPhoto =
  mongoose.models.FarmPhoto ||
  mongoose.model<IFarmPhoto>("FarmPhoto", FarmPhotoSchema);
