import { Router } from "express";
import { sendContactEmail } from "../services/email";

const router = Router();

// POST /api/contact
router.post("/", async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;
    if (!name || !email || !message)
      return res.status(400).json({ message: "Name, email and message are required" });

    await sendContactEmail({ name, email, phone: phone || "", message });
    res.json({ success: true, message: "Message sent successfully" });
  } catch (err) {
    console.error("Contact email error:", err);
    res.status(500).json({ message: "Failed to send message" });
  }
});

export default router;
