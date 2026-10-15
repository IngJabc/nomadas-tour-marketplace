import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkoutApi, type SubmitCheckoutProofResult } from '@/lib/api';
import { ApiError } from '@/lib/errors/api-error';
import {
  MAX_PROOF_BYTES,
  ProofUploader,
  proofFingerprint,
} from '@/components/booking/ProofUploader';

vi.mock('@/lib/api', () => ({
  checkoutApi: { submitProof: vi.fn() },
}));

const mockedSubmitProof = vi.mocked(checkoutApi.submitProof);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RECONCILIATION = {
  payment_reference: '00123456789',
  bank_origin: 'Banco de Venezuela',
  payment_datetime: '2020-01-01T10:00',
};

function proofResult(
  overrides: Partial<SubmitCheckoutProofResult> = {},
): SubmitCheckoutProofResult {
  return {
    attempt_id: 'att-1',
    status: 'pending_review',
    proof_count: 1,
    remaining_submissions: 2,
    proof_path: 'att-1/abc.png',
    payment_reference: RECONCILIATION.payment_reference,
    bank_origin: RECONCILIATION.bank_origin,
    payment_datetime: '2020-01-01T15:00:00.000Z',
    amount_cents: 4040,
    expires_at: '2020-01-02T10:00:00.000Z',
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

/** Los tres datos de conciliación son obligatorios antes de enviar. */
function fillReconciliation() {
  fireEvent.change(screen.getByLabelText('Referencia de la transferencia'), {
    target: { value: RECONCILIATION.payment_reference },
  });
  fireEvent.change(screen.getByLabelText('Banco de origen'), {
    target: { value: RECONCILIATION.bank_origin },
  });
  fireEvent.change(screen.getByLabelText('Fecha y hora del pago'), {
    target: { value: RECONCILIATION.payment_datetime },
  });
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

const onSubmitted = vi.fn();
const onAlreadySubmitted = vi.fn();

async function renderUploader(remainingSubmissions = 3) {
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(
      <ProofUploader
        attemptId="att-1"
        remainingSubmissions={remainingSubmissions}
        onSubmitted={onSubmitted}
        onAlreadySubmitted={onAlreadySubmitted}
      />,
    );
  });
  return view;
}

/** Selecciona archivo + conciliación, como lo haría el usuario real. */
async function prepareSubmission(view: ReturnType<typeof render>) {
  selectFile(view, buildFile());
  fillReconciliation();
}

beforeEach(() => {
  mockedSubmitProof.mockReset();
  onSubmitted.mockReset();
  onAlreadySubmitted.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ProofUploader (MKT-007)', () => {
  it('bloquea el envío hasta que exista un archivo seleccionado', async () => {
    const view = await renderUploader();

    expect(submitButton()).toBeDisabled();
    expect(mockedSubmitProof).not.toHaveBeenCalled();

    selectFile(view, buildFile());
    expect(submitButton()).toBeEnabled();
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();
    expect(screen.getByText(/\d+ KB/)).toBeInTheDocument();
  });

  it('nunca muestra un contador de reenvíos, ni con envíos disponibles', async () => {
    await renderUploader(2);

    expect(screen.queryByText(/Reenvío/)).not.toBeInTheDocument();
    expect(screen.queryByText(/de \d+ disponibles/)).not.toBeInTheDocument();
  });

  it('no muestra el contador en el primer envío', async () => {
    await renderUploader(3);

    expect(screen.queryByText(/Reenvío/)).not.toBeInTheDocument();
  });

  it('exige los tres datos de conciliación y no llama a la API', async () => {
    const view = await renderUploader();
    selectFile(view, buildFile());

    await clickSubmit();

    expect(
      screen.getByText('Escribe la referencia de la transferencia.'),
    ).toBeInTheDocument();
    expect(mockedSubmitProof).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(view).toBeTruthy();
  });

  it('rechaza una fecha de pago futura', async () => {
    const view = await renderUploader();
    selectFile(view, buildFile());
    fillReconciliation();
    fireEvent.change(screen.getByLabelText('Fecha y hora del pago'), {
      target: { value: '2999-01-01T10:00' },
    });

    await clickSubmit();

    expect(
      screen.getByText('La fecha del pago no puede estar en el futuro.'),
    ).toBeInTheDocument();
    expect(mockedSubmitProof).not.toHaveBeenCalled();
  });

  it('rechaza formatos no permitidos en el cliente sin llamar a la API', async () => {
    const view = await renderUploader();

    selectFile(view, buildFile('notas.exe', 'application/octet-stream'));
    fillReconciliation();

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

  it('envía folio, archivo, conciliación e Idempotency-Key en formato UUID', async () => {
    mockedSubmitProof.mockResolvedValue(proofResult());
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(1);
    const [attemptId, sentFile, reconciliation, key] =
      mockedSubmitProof.mock.calls[0];
    expect(attemptId).toBe('att-1');
    expect(sentFile).toBeInstanceOf(File);
    expect(reconciliation).toEqual({
      payment_reference: RECONCILIATION.payment_reference,
      bank_origin: RECONCILIATION.bank_origin,
      payment_datetime: '2020-01-01T10:00:00.000Z',
    });
    expect(key).toMatch(UUID_RE);
    expect(onSubmitted).toHaveBeenCalledWith(proofResult());
  });

  it('trata la respuesta idempotente como un envío pendiente de revisión', async () => {
    mockedSubmitProof.mockResolvedValue(proofResult({ idempotent: true }));
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    expect(onSubmitted).toHaveBeenCalledWith(
      proofResult({ idempotent: true }),
    );
    // El componente jamás afirma "aprobado"/"pagado": lo decide el padre.
    expect(screen.queryByText(/aprobado/i)).not.toBeInTheDocument();
  });

  it('conserva la misma clave al reintentar el mismo archivo tras un error', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    mockedSubmitProof.mockResolvedValueOnce(proofResult());
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    const firstKey = mockedSubmitProof.mock.calls[0][3];
    expect(firstKey).toMatch(UUID_RE);
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    // La selección no se pierde en un error recuperable.
    expect(screen.getByText('comprobante.png')).toBeInTheDocument();

    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][3]).toBe(firstKey);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('genera una clave nueva cuando el usuario elige otro archivo', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();
    selectFile(view, buildFile('otro.png', 'image/png', undefined, 'otra-imagen'));
    fillReconciliation();

    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][3];

    // La identidad es por CONTENIDO: un archivo distinto es otro contenido,
    // aunque repita formato o tamaño.
    selectFile(
      view,
      buildFile('distinto.pdf', 'application/pdf', undefined, 'documento-nuevo'),
    );
    mockedSubmitProof.mockResolvedValueOnce(proofResult());
    await clickSubmit();

    expect(mockedSubmitProof.mock.calls[1][3]).not.toBe(firstKey);
    expect(mockedSubmitProof.mock.calls[1][3]).toMatch(UUID_RE);
  });

  it('nombre distinto con el mismo contenido comparte la clave: es la misma operación', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();
    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', undefined, 'mismo-bytes'),
    );
    fillReconciliation();

    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][3];

    // El backend identifica el comprobante por el hash del contenido
    // (`{attempt_id}/{sha256}.{ext}`): renombrar los bytes no crea una
    // operación nueva.
    selectFile(
      view,
      buildFile('copia-rebautizada.webp', 'image/webp', undefined, 'mismo-bytes'),
    );
    mockedSubmitProof.mockResolvedValueOnce(proofResult());
    await clickSubmit();

    expect(mockedSubmitProof.mock.calls[1][3]).toBe(firstKey);
  });

  it('archivos distintos con igual nombre y tamaño reciben claves distintas (H-01)', async () => {
    mockedSubmitProof.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const view = await renderUploader();

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', 7777, 'contenido-uno'),
    );
    fillReconciliation();
    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][3];

    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', 7777, 'contenido-dos'),
    );
    mockedSubmitProof.mockResolvedValueOnce(proofResult());
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][3]).not.toBe(firstKey);
    expect(mockedSubmitProof.mock.calls[1][3]).toMatch(UUID_RE);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('mismo archivo y mismo intento: los reenvíos consecutivos usan la misma clave', async () => {
    mockedSubmitProof
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(proofResult());
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();
    await clickSubmit();
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(3);
    const keys = mockedSubmitProof.mock.calls.map((call) => call[3]);
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
    fillReconciliation();
    await clickSubmit();
    const firstKey = mockedSubmitProof.mock.calls[0][3];
    expect(screen.getByRole('alert')).toBeInTheDocument();

    // Objeto File distinto pero contenido idéntico: sigue siendo la misma
    // operación, así que conserva la clave del intento original.
    selectFile(
      view,
      buildFile('comprobante.png', 'image/png', undefined, 'mismo-contenido'),
    );
    mockedSubmitProof.mockResolvedValueOnce(proofResult());
    await clickSubmit();

    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][3]).toBe(firstKey);
    expect(onSubmitted).toHaveBeenCalledTimes(1);
  });

  it('deshabilita el envío mientras la solicitud está en vuelo', async () => {
    let resolveSubmit: (value: SubmitCheckoutProofResult) => void = () => {};
    mockedSubmitProof.mockReturnValue(
      new Promise<SubmitCheckoutProofResult>((resolve) => {
        resolveSubmit = resolve;
      }),
    );

    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmitUntilCall(1);

    expect(
      screen.getByRole('button', { name: /Enviando comprobante/ }),
    ).toBeDisabled();
    expect(
      view.container.querySelector('input[type="file"]'),
    ).toBeDisabled();

    await act(async () => {
      resolveSubmit(proofResult());
    });

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
  });

  it('CHECKOUT_PROOF_PENDING pasa a revisión sin afirmar éxito de esta respuesta', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'Este comprobante ya está en revisión',
        'CHECKOUT_PROOF_PENDING',
        409,
      ),
    );
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    expect(onAlreadySubmitted).toHaveBeenCalledTimes(1);
    expect(onSubmitted).not.toHaveBeenCalled();
    // Un solo intento: nada se reintenta ni se inventa un identificador.
    expect(mockedSubmitProof).toHaveBeenCalledTimes(1);
    expect(view).toBeTruthy();
  });

  it('CHECKOUT_IDEMPOTENCY_CONFLICT explica el problema y no regenera la clave', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'La clave de idempotencia ya se usó con otro comprobante',
        'CHECKOUT_IDEMPOTENCY_CONFLICT',
        409,
      ),
    );
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    expect(
      screen.getByText(/otra clave de idempotencia/i),
    ).toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onAlreadySubmitted).not.toHaveBeenCalled();

    const keyAfterConflict = mockedSubmitProof.mock.calls[0][3];
    await clickSubmit();

    // Segundo intento manual: MISMA clave, nunca una clave nueva automática.
    expect(mockedSubmitProof).toHaveBeenCalledTimes(2);
    expect(mockedSubmitProof.mock.calls[1][3]).toBe(keyAfterConflict);
  });

  it('CHECKOUT_WINDOW_EXPIRED traduce el copy del backend a mensaje de cliente', async () => {
    // Código real del backend público (checkout.service.ts): 409 con
    // message "El plazo de revisión de tu compra venció" (jerga prohibida).
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'El plazo de revisión de tu compra venció',
        'CHECKOUT_WINDOW_EXPIRED',
        409,
      ),
    );
    const view = await renderUploader();
    await prepareSubmission(view);

    await clickSubmit();

    expect(
      screen.getByText('El tiempo de revisión expiró. Vuelve a intentar tu reserva.'),
    ).toBeInTheDocument();
    // El texto crudo del backend (jerga de "plazo"/"ventana") jamás llega.
    expect(screen.queryByText(/plazo|ventana/i)).not.toBeInTheDocument();
    expect(onSubmitted).not.toHaveBeenCalled();
    expect(view).toBeTruthy();
  });

  it('errores de archivo del backend se muestran sin perder la selección', async () => {
    mockedSubmitProof.mockRejectedValue(
      new ApiError(
        'El contenido del archivo no corresponde a un comprobante válido',
        'CHECKOUT_PROOF_FILE_INVALID',
        400,
      ),
    );
    const view = await renderUploader();
    await prepareSubmission(view);

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
    await prepareSubmission(view);

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
