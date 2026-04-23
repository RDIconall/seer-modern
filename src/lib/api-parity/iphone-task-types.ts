/**
 * JSON shapes derived from legacy APIController.scala (Play / iOS RestKit).
 * Use with OpenAPI in openapi/seer-api-parity.yaml.
 */

export type IphoneLabel = {
  id: string;
  label: string;
  name: string;
  processedEmails: number;
  totalEmails: number;
  monitored: boolean;
};

export type IphoneAccount = {
  id: string;
  name: string;
  accountType: string;
  primary: boolean;
  email?: string;
  googlePlus?: boolean;
  googleContacts?: boolean;
  labels: IphoneLabel[];
};

export type IphoneContact = {
  email: string;
  name: string;
  pictureURL?: string;
  relationship: string;
  sent: number;
  received: number;
};

export type IphoneUserinfo = {
  email: string;
  name: string;
  autoStar: boolean;
  autoUnstar: boolean;
  subscribed: boolean;
  remindTime: number;
  expiration: number;
  reminderDelay: number;
  followupDelay: number;
  emailAddresses: string[];
};

export type IphoneAttachment = { id: string; name: string };

export type IphoneEmail = {
  id: string;
  link: string;
  time: number;
  subject: string;
  text: string;
  html: string;
  attachments: IphoneAttachment[];
  from: IphoneContact;
  to: IphoneContact[];
  cc: IphoneContact[];
  bcc: IphoneContact[];
};

export type IphoneSentenceOffset = {
  emailID: string;
  sentence: string;
  sentenceNumber: number;
  textStart: number;
  textEnd: number;
  htmlStart: number;
  htmlEnd: number;
};

export type IphoneTask = {
  id: string;
  taskType: string;
  name: string;
  deferred: boolean;
  score: number;
  sentence?: string;
  receivedCount?: number;
  logoURL?: string;
  email: IphoneEmail;
  sentenceOffsets: IphoneSentenceOffset[];
};
