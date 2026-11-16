// @effect-diagnostics extendsNativeError:off -- Plain async helpers reject with native errors; callers map them.
function gitBoolean(value: string | undefined): boolean {
  if (value === undefined) return true;
  if (value === "") return false;
  const word = value.toLowerCase();
  if (["true", "yes", "on"].includes(word)) return true;
  if (["false", "no", "off"].includes(word)) return false;
  const match = /^([+-]?)(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)([kmg]?)$/i.exec(value);
  if (!match) throw new EffectiveSigningConfigError("invalid");
  const digits = match[2]!;
  const magnitude =
    digits.length > 1 && digits.startsWith("0") && !digits.toLowerCase().startsWith("0x")
      ? BigInt(`0o${digits.slice(1)}`)
      : BigInt(digits);
  const power = ({ "": 0n, k: 1n, m: 2n, g: 3n } as const)[
    match[3]!.toLowerCase() as "" | "k" | "m" | "g"
  ];
  const number = magnitude * 1024n ** power * (match[1] === "-" ? -1n : 1n);
  if (number < -2147483648n || number > 2147483647n)
    throw new EffectiveSigningConfigError("invalid");
  return number !== 0n;
}

class EffectiveSigningConfigError extends Error {
  readonly reason: "invalid" | "unsupported";
  constructor(reason: "invalid" | "unsupported") {
    super(`Signing configuration ${reason}`);
    this.reason = reason;
  }
}

/** Parse ordered output from Git's --includes --null --show-origin --show-scope --list.
 * This selects values only; it does not establish executable or key trust. */
export function parseEffectiveSigningConfig(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes);
  const text = buffer.toString("utf8");
  if (!Buffer.from(text).equals(buffer)) throw new EffectiveSigningConfigError("invalid");
  const records = text.split("\0");
  if (records.pop() !== "" || records.length % 3 !== 0)
    throw new EffectiveSigningConfigError("invalid");
  let format = "openpgp";
  let program = "gpg";
  let signingKey: string | undefined;
  let commitSign: boolean | undefined;
  for (let i = 0; i < records.length; i += 3) {
    const scope = records[i]!;
    const origin = records[i + 1]!;
    const record = records[i + 2]!;
    if (!scope || !origin || !record) throw new EffectiveSigningConfigError("invalid");
    const separator = record.indexOf("\n");
    const name = separator === -1 ? record : record.slice(0, separator);
    const value = separator === -1 ? undefined : record.slice(separator + 1);
    // Git folds section and variable names, not subsection names.
    const parts = name.split(".");
    const section = parts[0]?.toLowerCase();
    const variable = parts.at(-1)?.toLowerCase();
    const plain = parts.length === 2;
    const isProgram =
      section === "gpg" &&
      variable === "program" &&
      (plain || (parts.length === 3 && parts[1] === "openpgp"));
    const recognized =
      isProgram ||
      (plain &&
        ((section === "gpg" && variable === "format") ||
          (section === "user" && variable === "signingkey") ||
          (section === "commit" && variable === "gpgsign")));
    if (!recognized) continue;
    if (section === "commit" && variable === "gpgsign") {
      commitSign = gitBoolean(value);
    } else {
      if (!value || /[\0\r\n]/.test(value)) throw new EffectiveSigningConfigError("invalid");
      if (isProgram) program = value;
      else if (section === "gpg") format = value;
      else signingKey = value;
    }
  }
  if (format !== "openpgp") throw new EffectiveSigningConfigError("unsupported");
  if (!signingKey || !/^(?:[0-9A-F]{40}|[0-9A-F]{64})!$/.test(signingKey))
    throw new EffectiveSigningConfigError("unsupported");
  return { format, program, fingerprint: signingKey.slice(0, -1), commitSign };
}
