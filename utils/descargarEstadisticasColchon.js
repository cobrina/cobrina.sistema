// utils/descargarEstadisticasColchon.js
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

export const descargarEstadisticasColchon = () => {
  const element = document.getElementById("estadisticas-colchon");
  if (!element) return;

  html2canvas(element, { scale: 2 }).then((canvas) => {
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const pdfWidth = pdf.internal.pageSize.getWidth();
    const pdfHeight = (canvas.height * pdfWidth) / canvas.width;

    pdf.addImage(imgData, "PNG", 0, 0, pdfWidth, pdfHeight);
    pdf.save("estadisticas-colchon.pdf");
  });
};
