// middleware/uploadMiddleware.js
import multer from "multer";

// Configuración de almacenamiento: usamos memoria, no disco
const storage = multer.memoryStorage();

// Filtro de tipo de archivo permitido (solo Excel XLSX o CSV)
const fileFilter = (req, file, cb) => {
  const allowedMimes = [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
    "text/csv",
  ];

  if (allowedMimes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error(
        "Formato no permitido. Solo se aceptan archivos XLSX, XLS o CSV."
      )
    );
  }
};

// Configuración principal
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // ⬆️ Aumentamos a 10 MB
  fileFilter,
});

// Exporta función para rutas con un solo archivo
export const uploadSingle = (fieldName = "file") => upload.single(fieldName);

// Exporta función para rutas que aceptan varios archivos a la vez
export const uploadMultiple = (fieldName = "files", maxCount = 5) =>
  upload.array(fieldName, maxCount);

export default upload;
