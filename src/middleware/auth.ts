import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { AdminUser } from "../models/AdminUser";

export interface AuthRequest extends Request {
  user?: { id: string; email: string; role?: string };
}

export const authMiddleware = (
  req: AuthRequest,
  res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer "))
    return res.status(401).json({ message: "No token provided" });

  const token = authHeader.split(" ")[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET as string) as {
      id: string; email: string; role?: string;
    };
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid token" });
  }
};

// Admin-only routes. Customer and admin tokens share JWT_SECRET, so a valid signature is not
// enough: the token's subject must be a real AdminUser. Admin login tokens carry role "admin";
// older admin tokens have no role and are accepted ONLY because their subject is an AdminUser
// (never merely because the role is missing). Customer tokens (role "user") are refused.
export const adminOnly = (req: AuthRequest, res: Response, next: NextFunction) => {
  authMiddleware(req, res, async () => {
    const role = req.user?.role;
    const id = req.user?.id;
    if ((role !== undefined && role !== "admin") || !id || !mongoose.isValidObjectId(id))
      return res.status(403).json({ message: "Admin access required" });
    try {
      if (!(await AdminUser.exists({ _id: id })))
        return res.status(403).json({ message: "Admin access required" });
    } catch {
      return res.status(500).json({ message: "Authorization check failed" });
    }
    next();
  });
};
