export function reqEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Set the ${name} environment variable`);
    }
    return v;
}
