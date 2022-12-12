const _write = process.stdout.write;
const _log = process.log;

export const restore = function () {
  // restore to the originals
  process.stdout.write = _write;
  process.log = _log;
};

export const stdout = function () {
  const logs: any[] = [];

  // lazily backup write to enable injection
  const { write } = process.stdout;
  const { log } = process;

  // electron adds a new process.log
  // method for windows instead of process.stdout.write
  // https://github.com/cypress-io/cypress/issues/977
  if (log) {
    process.log = function (str: string) {
      logs.push(str);

      // @ts-ignore
      // eslint-disable-next-line prefer-rest-params
      return log.apply(this, arguments);
    };
  }

  process.stdout.write = function (str) {
    logs.push(str);

    // @ts-ignore
    // eslint-disable-next-line prefer-rest-params
    return write.apply(this, arguments);
  };

  return {
    toString() {
      return logs.join("");
    },

    data: logs,

    restore,
  };
};
