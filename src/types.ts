export interface FarosClientConfig {
  readonly url: string;
  readonly apiKey: string;
  readonly phantoms?: Phantom;
}

export enum GraphVersion {
  V2 = 'v2',
}

export enum Phantom {
  Only = 'only',
  Exclude = 'exclude',
  Include = 'include',
  IncludeNestedOnly = 'include-nested-only',
}

export interface NamedQuery {
  readonly dataPath: string;
  readonly query: string;
}

export interface SecretName {
  readonly name: string;
  readonly group?: string;
}

export interface Account {
  readonly accountId: string;
  readonly tenantId: string;
  readonly farosApiKeyId: string;
  readonly type: string;
  readonly mode?: string | null;
  readonly params: Record<string, any>;
  readonly secretName: SecretName;
  readonly scheduleExpression?: string | null;
  readonly executionTimeoutInSecs: number;
  readonly runtimeVersion?: string | null;
  readonly memorySizeInMbs: number;
  readonly version?: string | null;
  readonly lastModified: Date;
}

export type UpdateAccount = Omit<Account, 'lastModified'>;

export interface Location {
  readonly uid: string;
  readonly raw: string;
  readonly address?: Address;
  readonly coordinates?: Coordinates;
  readonly room?: string;
}

export interface Address {
  readonly uid: string;
  readonly fullAddress?: string;
  readonly street?: string;
  readonly houseNumber?: string;
  readonly unit?: string;
  readonly postalCode?: string;
  readonly city?: string;
  readonly state?: string;
  readonly stateCode?: string;
  readonly country?: string;
  readonly countryCode?: string;
}

export interface Coordinates {
  lat: number;
  lon: number;
}

export interface Model {
  name: string;
  key: ReadonlyArray<string>;
  forwardReferences: any;
  backwardReferences: any;
  keySchema: any;
  dataSchema: any;
}

export interface UpdateWebhookEventStatus {
  webhookId: string;
  eventId: string;
  status: string;
  error?: string;
}

export interface WebhookEvent {
  id: string;
  name: string;
  webhookId: string;
  event: any;
  status: WebhookEventStatus;
  error?: string;
  createdAt?: Date;
  receivedAt: Date;
  updatedAt: Date;
}

export enum WebhookEventStatus {
  Pending = 'Pending',
  Ok = 'OK',
  Error = 'Error',
}
