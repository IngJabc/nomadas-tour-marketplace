import '@testing-library/jest-dom/vitest';

// jsdom no implementa object URLs (los usa la miniatura del comprobante en
// ProofUploader): sin este stub el guard del componente siempre cae en el
// icono de respaldo y el branch de la imagen quedaría sin cubrir.
if (typeof URL.createObjectURL !== 'function') {
  URL.createObjectURL = () => 'blob:proof-preview';
}
if (typeof URL.revokeObjectURL !== 'function') {
  URL.revokeObjectURL = () => {};
}
