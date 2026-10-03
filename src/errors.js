// A handled failure carries a machine-readable code so the tool layer can
// build the { error: { code, message } } envelope. Anything thrown that is NOT
// an AppError becomes { code: "internal" } — a bug, not an expected condition.
export class AppError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "AppError";
  }
}

// code ∈ validation | photo_preflight | not_found | provider |
//        expired_output | ffmpeg | not_ready | internal
export const fail = (code, message) => {
  throw new AppError(code, message);
};
