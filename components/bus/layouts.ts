export interface VehicleRow {
  cells: (string | null)[];
  doorCells?: number;
}

export const kiaRows: VehicleRow[] = [
  { cells: ['A10', 'A9', 'A8', 'A7'] },
  { cells: [null, null, 'A6', 'A5'] },
  { cells: [null, null, 'A4', 'A3'] },
  { cells: [null, null, 'A2', 'A1'], doorCells: 2 },
];

export const busRows: VehicleRow[] = [
  { cells: ['A31', 'A30', 'A29', 'A28', 'A27'] },
  { cells: ['A26', 'A25', null, 'A24', 'A23'] },
  { cells: ['A22', 'A21', null, 'A20', 'A19'] },
  { cells: ['A18', 'A17', null, 'A16', 'A15'] },
  { cells: ['A14', 'A13', null, 'A12', 'A11'] },
  { cells: ['A10', 'A9', null, 'A8', 'A7'] },
  { cells: ['A6', 'A5', null, 'A4', 'A3'] },
  { cells: [null, null, null, 'A2', 'A1'], doorCells: 2 },
];

export function rowsFor(vehicleType: 'bus' | 'kia'): VehicleRow[] {
  return vehicleType === 'kia' ? kiaRows : busRows;
}
