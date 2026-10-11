import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { paymentApi, type SubmitPaymentProofResult } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import {
  MAX_PROOF_BYTES,
  ProofUploader,
  proofFingerprint,
} from '@/components/booking/ProofUploader';

vi.mock('@/lib/api', () => ({
  paymentApi: { submitProof: vi.fn() },
}));

const mockedSubmitProof = vi.mocked(paymentApi.submitProof);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function paymentResult(
  overrides: Partial<SubmitPaymentProofResult> = {},
): SubmitPaymentProofResult {
  return {
    payment_id: 'pay-1',
    reservation_id: 'res-1',
    payment_status: 'pending',
    reservation_status: 'reserved',
    amount_cents: 4040,
    currency: 'USD',
    submitted_at: '2026-10-04T12:00:00.000Z',
    idempotent: false,
    ...overrides,
  };
}

function buildFile(
  name = 'comprobante.png',
  type = 'image/png',
  size?: number,
  content = 'contenido',
): File {
  const file = new File([content], name, { type });
  if (size !== undefined) {
    Object.defineProperty(file, 'size', { value: size, configurable: true });
  }
  return file;
}

function selectFile(view: ReturnType<typeof render>, file: File) {
  const input = view.container.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [file],
    configurable: true,
    writable: true,
  });
  fireEvent.change(input);
  return input;
}

function submitButton() {
  return screen.getByRole('button', { name: /Enviar comprobante/ });
}

function sendingButton() {
  return screen.queryByRole('button', { name: /Enviando comprobante/ });
}

/**
 * La clave de idempotencia sale de la huella del contenido, que es
 * asíncrona: el envío real llega a la API después del clic. Este helper
 * espera a que la cadena termine (éxito, conflicto o error) para que
 * ninguna continuación se filtre al siguiente test.
 */
async function clickSubmit() {
  await act(async () => {
    fireEvent.click(submitButton());
  });
  await waitFor(() => {
    expect(sendingButton()).not.toBeInTheDocument();
  });
}

/**
 * Igual que `clickSubmit`, pero para envíos cuya promesa queda abierta:
 * solo espera a que la API sea invocada.
 */
async function clickSubmitUntilCall(count: number) {
  await act(async () => {
    fireEvent.click(submitButton());
  });
  await waitFor(() => {
    expect(mockedSubmitProof).toHaveBeenCalledTimes(count);
  });
}

async function renderUploader() {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <ProofUploader
        reservationId="res-1"
        onSubmitted={onSubmitted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );
  });
  return view;
}

const onSubmitted = vi.fn();
const onAlreadySubmitted = vi.fn();

beforeEach(() => {
  mockedSubmitProof.mockReset();
  onSubmitted.mockReset();
  onAlreadySubmitted.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProofUploader (MKT-005 Fase 3)', () => {
  it('bloquea el envío hasta que exista un archivo seleccionado', async () => {
    const view = await renderUploader();

    expect(submitButton()).toBeDisabled();
    expect(mockedSubmitProof).not.toHaveBeenCalled();

    selectFile(view, buildFile());
    expect(submitButton()).toBeEnabled();
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();
    expect(screen.getByText(/\d+ KB/)).toBeInTheDocument();
  });

  it('rechaza formatos no permitidos en el cliente sin llamar a la API', async () => {
    const view = await renderUploader();

    selectFile(view, buildFile('notas.exe', 'application/octet-stream'));

    expect(
      screen.getByText('Adjunta el comprobante en formato PNG, JPEG, WEBP o PDF.'),
    ).toBeInTheDocument();

    await clickSubmit();

    expect(mockedSubmitProof).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('rechaza archivos por encima de 5 MiB en el cliente', async () => {
    const view = await renderUploader();

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', MAX_PROOF_BYTES + 1),
    );

    expect(
      screen.getByText('El comprobante no puede superar 5 MB.'),
    ).toBeInTheDocument();

    await clickSubmit();

    expect(mockedSubmitProof).not.toHaveBeenCalled();
  });

  it('acepta los cuatro formatos permitidos', async () => {
    for (const [name, type] of [
      ['a.png', 'image/png'],
      ['b.jpg', 'image/jpeg'],
      ['c.webp', 'image/webp'],
      ['d.pdf', 'application/pdf'],
    ] as const) {
      const view = await renderUploader();
      selectFile(view, buildFile(name, type));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      view.unmount();
    }
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('envía con Idempotency-Key en formato UUID y notifica al padre', async () => {
    mockedSubmitProof.mockResolvedValue(paymentResult());
    const view = await renderUploader();
    const file = buildFile();
    selectFile(view, file);

    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(1);
    const [reservationId, sentFile, key] = mockedSubmitProof.mock.calls[0];
    expect(reservationId).toBe('res-1');
    expect(sentFile).toBe(file);
    expect(key).toMatch(UUID_RE);
    expect(onSubmitted).toHaveBeenCalledWith(paymentResult());
  });

  it('trata la respuesta idempotente como un envío pendiente de revisión', async () => {
    mockedSubmitProof.mockResolvedValue(paymentResult({ idempotent: true }));
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(onSubmitted).toHaveBeenCalledWith(
      paymentResult({ idempotent: true }),
    );
    // El componente jamás afirma "aprobado"/"pagado": lo decide el padre.
    expect(screen.queryByText(/aprobado/i)).not.toBeInTheDocument();
  });

  it('conserva la misma clave al reintentar el mismo archivo tras un error', async () => {
    mockedSubmitProof.mockRejectedValueOnce(
      new TypeError('Failed to fetch'),
    );
    mockedSubmitProof.mockResolvedValueOnce(paymentResult());
    const view = await renderUploader();
    const file = buildFile();
    selectFile(view, file);

    await clickSubmit();

    const firstKey = mockedSubmitProof.mock.calls[0][2];
    expect(firstKey).toMatch(UUID_RE);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // La selección no se pierde en un error recuperable.
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();

    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][2]).toBe(firstKey);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('genera una clave nueva cuando el usuario elige otro archivo', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();
    selectFile(view, buildFile('otro.png', 'image/png', undefined, 'otra-imagen'));

    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][2];

    // La identidad es por CONTENIDO: un archivo distinto es otro contenido,
    // aunque repita formato o tamaño.
    selectFile(
      view,
      buildFile('distinto.pdf', 'application/pdf', undefined, 'documento-nuevo'),
    );
    mockedSubmitProof.mockResolvedValueOnce(paymentResult());
    await clickSubmit();

    expect(mockedSubmitProof.mock.calls[1][2]).not.toBe(firstKey);
    expect(mockedSubmitProof.mock.calls[1][2]).toMatch(UUID_RE);
  });

  it('nombre distinto con el mismo contenido comparte la clave: es la misma operación', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();
    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', undefined, 'mismo-bytes'),
    );

    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][2];

    // El backend identifica el comprobante por el hash del contenido
    // (`{reservation_id}/{sha256}.{ext}`): renombrar los bytes no crea una
    // operación nueva.
    selectFile(
      view,
      buildFile('copia-rebautizada.webp', 'image/webp', undefined, 'mismo-bytes'),
    );
    mockedSubmitProof.mockResolvedValueOnce(paymentResult());
    await clickSubmit();

    expect(mockedSubmitProof.mock.calls[1][2]).toBe(firstKey);
  });

  it('archivos distintos con igual nombre y tamaño reciben claves distintas (H-01)', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', 7777, 'contenido-uno'),
    );
    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][2];

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', 7777, 'contenido-dos'),
    );
    mockedSubmitProof.mockResolvedValueOnce(paymentResult());
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][2]).not.toBe(firstKey);
    expect(mockedSubmitProof.mock.calls[1][2]).toMatch(UUID_RE);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('mismo archivo y mismo intento: los reenvíos consecutivos usan la misma clave', async () => {
    mockedSubmitProof
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(paymentResult());
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();
    await clickSubmit();
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(3);
    const keys = mockedSubmitProof.mock.calls.map((call) => call[2]);
    expect(keys[0]).toMatch(UUID_RE);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).toBe(keys[0]);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('re-seleccionar el mismo contenido tras un error conserva la clave original', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', undefined, 'mismo-contenido'),
    );
    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][2];
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Objeto File distinto pero contenido idéntico: sigue siendo la misma
    // operación, así que conserva la clave del intento original.
    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', undefined, 'mismo-contenido'),
    );
    mockedSubmitProof.mockResolvedValueOnce(paymentResult());
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][2]).toBe(firstKey);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('deshabilita el envío mientras la solicitud está en vuelo', async () => {
    let resolveSubmit: (value: SubmitPaymentProofResult) => void = () => {};
    mockedSubmitProof.mockReturnValue(
      new Promise<SubmitPaymentProofResult>((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmitUntilCall(1);

    expect(
      screen.getByRole('button', { name: /Enviando comprobante/ }),
    ).toBeDisabled();
    expect(
      view.container.querySelector('input[type="file"]'),
    ).toBeDisabled();

    await act(async () => {
      resolveSubmit(paymentResult());
    });

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('PAYMENT_ALREADY_SUBMITTED pasa a revisión sin afirmar éxito de esta respuesta', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'El comprobante de esta reserva ya fue enviado',
        'PAYMENT_ALREADY_SUBMITTED',
        409,
      ),
    );
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(onAlreadySubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).not.toHaveBeenCalled();
    // Un solo intento: nada se reintenta ni se inventa un identificador.
    expect(mockedSubmitProof).toHaveBeenCalledTimes(1);
    expect(view).toBeTruthy();
  });

  it('PAYMENT_IDEMPOTENCY_CONFLICT explica el problema y no regenera la clave', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'La clave de idempotencia ya se usó con otro comprobante',
        'PAYMENT_IDEMPOTENCY_CONFLICT',
        409,
      ),
    );
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(
      screen.getByText(/Otra clave de idempotencia|otra clave de idempotencia/),
    ).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onAlreadySubmitted).not.toHaveBeenCalled();

    const keyAfterConflict = mockedSubmitProof.mock.calls[0][2];
    await clickSubmit();

    // Segundo intento manual: MISMA clave, nunca una clave nueva automática.
    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][2]).toBe(keyAfterConflict);
  });

  it('PAYMENT_LOCK_EXPIRED muestra el mensaje del backend sin promover la reserva', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'Tu selección de asientos expiró. Resérvalos de nuevo',
        'PAYMENT_LOCK_EXPIRED',
        409,
      ),
    );
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(
      screen.getByText('Tu selección de asientos expiró. Resérvalos de nuevo'),
    ).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(view).toBeTruthy();
  });

  it('errores de archivo del backend se muestran sin perder la selección', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'El contenido del archivo no corresponde a un comprobante válido',
        'PAYMENT_FILE_INVALID',
        400,
      ),
    );
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(screen.getByRole('alert')).toHaveTextContent(
      'El contenido del archivo no corresponde a un comprobante válido',
    );
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
  });

  it('un error de red conserva la selección y permite reintentar', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();
  });
});

describe('proofFingerprint (identidad por contenido)', () => {
  it('ignora nombre y tamaño: dos objetos distintos con el mismo contenido comparten huella', async () => {
    const first = buildFile('comprobante.png', 'image/png', 7777, 'contenido-a');
    const second = buildFile('otro-nombre.png', 'image/jpeg', 9999, 'contenido-a');

    await expect(proofFingerprint(first)).resolves.toBe(
      await proofFingerprint(second),
    );
  });

  it('distingue contenidos distintos aunque nombre y tamaño coincidan', async () => {
    const first = buildFile('comprobante.png', 'image/png', 7777, 'contenido-uno');
    const second = buildFile('comprobante.png', 'image/png', 7777, 'contenido-dos');

    expect(await proofFingerprint(first)).not.toBe(
      await proofFingerprint(second),
    );
  });

  it('devuelve una huella determinista para el mismo archivo', async () => {
    const file = buildFile(
      'comprobante.png',
      'image/png',
      undefined,
      'contenido-estable',
    );

    expect(await proofFingerprint(file)).toBe(await proofFingerprint(file));
  });
});
