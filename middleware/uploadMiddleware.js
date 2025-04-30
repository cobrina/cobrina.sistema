// middleware/uploadMiddleware.js
import multer from "multer";

// Almacenamiento en memoria
const storage = multer.memoryStorage();

// Limita el tamaño del archivo a 5 MB
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
});

export default upload;
