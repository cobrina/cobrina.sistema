const MESES = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export const formatearFecha = (fecha) => {
  if (!fecha) return "";
  const texto = String(fecha);
  const soloFecha = texto.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const d = soloFecha
    ? new Date(Number(soloFecha[1]), Number(soloFecha[2]) - 1, Number(soloFecha[3]), 12, 0, 0, 0)
    : new Date(fecha);
  if (Number.isNaN(d.getTime())) return "";
  const dia = String(d.getDate()).padStart(2, "0");
  const mes = MESES[d.getMonth()];
  return `${dia}/${mes}/${d.getFullYear()}`;
};
