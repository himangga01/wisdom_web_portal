export interface PasswordKdfPermit {
  release(): void;
}

export interface PasswordKdfGate {
  acquire(): Promise<PasswordKdfPermit>;
}

export function createPasswordKdfGate(limit: number): PasswordKdfGate {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Password KDF concurrency limit must be a positive integer");
  }
  let active = 0;
  const waiters: Array<(permit: PasswordKdfPermit) => void> = [];

  const createPermit = (): PasswordKdfPermit => {
    let released = false;
    return {
      release() {
        if (released) return;
        released = true;
        const next = waiters.shift();
        if (next) {
          // The active permit is transferred directly so a late arrival cannot barge.
          next(createPermit());
        } else {
          active -= 1;
        }
      },
    };
  };

  return {
    acquire() {
      if (active < limit && waiters.length === 0) {
        active += 1;
        return Promise.resolve(createPermit());
      }
      return new Promise<PasswordKdfPermit>((resolve) => { waiters.push(resolve); });
    },
  };
}
