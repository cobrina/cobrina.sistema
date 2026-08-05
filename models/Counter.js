// backend/models/Counter.js
import mongoose from "mongoose";
const { Schema } = mongoose;

/**
 * Contador genérico por nombre de secuencia.
 * Lo usamos para emitir ID numéricos incrementales para pagos.
 */
const CounterSchema = new Schema(
  {
    sequenceName: { type: String, required: true, unique: true, index: true },
    seq: { type: Number, default: 0 },
  },
  { versionKey: false, timestamps: false }
);

const Counter = mongoose.model("Counter", CounterSchema);
export default Counter;
