// scripts/seedSuperAdmin.js
import mongoose from "mongoose";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import Empleado from "../models/Empleado.js";

dotenv.config();

const crearSuperAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    const existe = await Empleado.findOne({ username: "Ceballos1988" });
    if (existe) {
      console.log("⚠️ El usuario 'Ceballos1988' ya existe.");
      process.exit();
    }

    const hashedPassword = await bcrypt.hash("Ceballos1988*", 10);

    const superAdmin = new Empleado({
      username: "Ceballos1988",
      password: hashedPassword,
      email: "1988mceballos@gmail.com",
      role: "super-admin",
    });

    await superAdmin.save();
    console.log("✅ Super-admin creado con éxito.");
    process.exit();
  } catch (error) {
    console.error("❌ Error al crear el super-admin:", error);
    process.exit(1);
  }
};

crearSuperAdmin();
