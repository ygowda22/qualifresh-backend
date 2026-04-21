import mongoose, { Schema, Document } from "mongoose";

export interface ICategory extends Document {
  key: string;
  label: string;
  imageUrl: string;
  color: string;
  icon: string;
  isCustom: boolean;
  order: number;
}

const CategorySchema = new Schema<ICategory>(
  {
    key:      { type: String, required: true, unique: true },
    label:    { type: String, required: true },
    imageUrl: { type: String, default: "" },
    color:    { type: String, default: "#2d8a4e" },
    icon:     { type: String, default: "🥦" },
    isCustom: { type: Boolean, default: true },
    order:    { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Category =
  mongoose.models.Category ||
  mongoose.model<ICategory>("Category", CategorySchema);
