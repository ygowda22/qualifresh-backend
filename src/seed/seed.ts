import "dotenv/config";
import { connectDB } from "../config/db";
import { AdminUser } from "../models/AdminUser";
import { Product } from "../models/Product";
import { seedProducts } from "./products";

const run = async () => {
  await connectDB(process.env.MONGO_URI as string);

  // Seed admin
  const existingAdmin = await AdminUser.findOne({
    email: process.env.ADMIN_EMAIL
  });
  if (!existingAdmin) {
    await AdminUser.create({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD
    });
    console.log("Admin user created");
  } else {
    console.log("Admin user already exists");
  }

  // Seed products — upsert by slug so deleted products are restored without duplicating
  const ops = seedProducts.map(p => ({
    updateOne: {
      filter: { slug: p.slug },
      update: { $setOnInsert: p },
      upsert: true,
    }
  }));
  const result = await Product.bulkWrite(ops as any);
  const added = result.upsertedCount ?? 0;
  console.log(`Products upserted: ${added} new, ${seedProducts.length - added} already existed`);

  process.exit(0);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});