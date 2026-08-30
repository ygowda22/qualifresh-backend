import mongoose, { Schema, Document } from "mongoose";

export interface ITestimonialImage {
  url: string;
  alt: string;
}

export interface ITestimonial extends Document {
  name:      string;
  role:      string;
  message:   string;
  rating:    number;
  avatarUrl: string;
  images:    ITestimonialImage[];
  location:  string;
  isActive:  boolean;
  sortOrder: number;
}

const TestimonialImageSchema = new Schema<ITestimonialImage>(
  {
    url: { type: String, required: true },
    alt: { type: String, default: "" },
  },
  { _id: false }
);

const TestimonialSchema = new Schema<ITestimonial>(
  {
    name:      { type: String, required: true },
    role:      { type: String, default: "" },
    message:   { type: String, required: true, maxlength: 220 },
    rating:    { type: Number, default: 5, min: 1, max: 5 },
    avatarUrl: { type: String, default: "" },
    images:    { type: [TestimonialImageSchema], default: [] },
    location:  { type: String, default: "" },
    isActive:  { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export const Testimonial =
  mongoose.models.Testimonial ||
  mongoose.model<ITestimonial>("Testimonial", TestimonialSchema);
