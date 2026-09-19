export class UnsupportedConfigError extends Error {
  readonly configPath: string;
  readonly location: string;
  readonly reason: string;

  constructor(configPath: string, location: string, reason: string) {
    super(`Unsupported configuration in "${configPath}" at "${location}": ${reason}`);
    this.name = "UnsupportedConfigError";
    this.configPath = configPath;
    this.location = location;
    this.reason = reason;
  }
}
