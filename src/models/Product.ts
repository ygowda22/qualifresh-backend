import mongoose, { Schema, Document } from "mongoose";

export interface IProduct extends Document {
  name: string;
  slug: string;
  category: string;
  description: string;
  quantityLabel: string;
  unit: string;
  price: number;
  priceUnit: "per_unit" | "per_kg";
  isImported: boolean;
  isActive: boolean;
  stock: number;
  tags: string[];
  images: string[];
  imageUrl: string;
}

const ProductSchema = new Schema<IProduct>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    category: { type: String, required: true },
    description: { type: String, default: "" },
    quantityLabel: { type: String, required: true },
    unit: { type: String, required: true },
    price: { type: Number, required: true },
    priceUnit: { type: String, enum: ["per_unit", "per_kg"], default: "per_unit" },
    isImported: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    stock: { type: Number, default: 0 },
    tags: [{ type: String }],
    images: [{ type: String }],
    imageUrl: { type: String, default: "" }
  },
  { timestamps: true }
);

export const Product =
  mongoose.models.Product || mongoose.model<IProduct>("Product", ProductSchema);