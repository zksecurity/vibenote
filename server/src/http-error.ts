// HTTP errors that routes throw on purpose. `handleErrors` sends their status and message to the
// client; any other error is treated as unexpected and answered generically.

export { HttpError, HttpErrorClass };

function HttpError(status: number, message: string): HttpErrorClass {
  return new HttpErrorClass(status, message);
}

class HttpErrorClass extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
