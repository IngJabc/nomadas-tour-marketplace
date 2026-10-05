import type { PassengerDraft } from '@/lib/booking/lock-state';

export function emptyPassenger(seatId: string): PassengerDraft {
  return {
    seat_id: seatId,
    first_name: '',
    last_name: '',
    document: '',
    phone: '',
  };
}

export function passengerFullName(passenger: PassengerDraft): string {
  return `${passenger.first_name} ${passenger.last_name}`.replace(/\s+/g, ' ').trim();
}

export interface PassengerError {
  index: number;
  field: 'first_name' | 'last_name' | 'document' | 'phone';
  message: string;
}

const DOCUMENT_PATTERN = /^\d{7,8}$/;
const PHONE_PATTERN = /^(0\d{10}|\+\d{12,15})$/;

export function validatePassengers(
  passengers: PassengerDraft[],
): PassengerError[] {
  const errors: PassengerError[] = [];
  const seenDocuments = new Map<string, number>();

  passengers.forEach((passenger, index) => {
    const firstName = passenger.first_name.trim();
    const lastName = passenger.last_name.trim();
    const document = passenger.document.trim();
    const phone = passenger.phone.trim();

    if (firstName.length < 2) {
      errors.push({
        index,
        field: 'first_name',
        message: 'Escribe el nombre del pasajero',
      });
    }
    if (lastName.length < 2) {
      errors.push({
        index,
        field: 'last_name',
        message: 'Escribe el apellido del pasajero',
      });
    }
    if (!DOCUMENT_PATTERN.test(document)) {
      errors.push({
        index,
        field: 'document',
        message: 'Debe tener 7 u 8 dígitos',
      });
    } else if (seenDocuments.has(document)) {
      errors.push({
        index,
        field: 'document',
        message: 'Documento repetido en esta reserva',
      });
    } else {
      seenDocuments.set(document, index);
    }
    if (!PHONE_PATTERN.test(phone)) {
      errors.push({
        index,
        field: 'phone',
        message: 'Ingresa un teléfono válido (ej. 04241234567)',
      });
    }
  });

  return errors;
}
