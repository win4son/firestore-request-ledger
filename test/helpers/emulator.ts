import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';

export interface EmulatorConfig {
    readonly host: string;
    readonly projectId: string;
}

/**
 * Validate that the process is pointed strictly at a local Firestore emulator
 * under a `demo-` project id, so a misconfigured shell can never reach a real project.
 */
export function emulatorConfig(): EmulatorConfig {
    const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
    if (!/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host)) {
        throw new Error('Refusing to run: FIRESTORE_EMULATOR_HOST must point at a local emulator (run via `npm run test:integration`).');
    }
    const projectId = process.env.GCLOUD_PROJECT ?? 'demo-request-ledger';
    if (!projectId.startsWith('demo-')) throw new Error('Refusing to run: the project id must start with "demo-".');
    return { host, projectId };
}

/**
 * Connect to the local Firestore emulator only.
 */
export function emulatorFirestore(): Firestore {
    const { projectId } = emulatorConfig();
    return new Firestore({ projectId });
}

export function emulatorRestBase(): string {
    const { host, projectId } = emulatorConfig();
    return `http://${host}/v1/projects/${projectId}/databases/(default)/documents`;
}

/** A collection name no other test uses, so tests never share state. */
export function uniqueName(prefix: string): string {
    return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function uniqueRequestId(label: string): string {
    return `${label}-${randomUUID()}`;
}
