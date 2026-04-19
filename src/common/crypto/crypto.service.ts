import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

@Injectable()
export class CryptoService implements OnModuleInit {
  private encryption_key!: Buffer;

  constructor(private readonly config: ConfigService) {}

  onModuleInit(): void {
    const key_hex = this.config.get<string>('ENCRYPTION_KEY');
    if (!key_hex) {
      throw new Error('ENCRYPTION_KEY is required');
    }
    const key = Buffer.from(key_hex, 'hex');
    if (key.length !== 32) {
      throw new Error('ENCRYPTION_KEY must be 32 bytes (64 hex chars) for AES-256');
    }
    this.encryption_key = key;
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this.encryption_key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const auth_tag = cipher.getAuthTag();
    return Buffer.concat([iv, auth_tag, encrypted]).toString('base64');
  }

  decrypt(ciphertext: string): string {
    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const auth_tag = data.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
    const decipher = createDecipheriv(ALGORITHM, this.encryption_key, iv);
    decipher.setAuthTag(auth_tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  hashSha256(value: string, salt = ''): string {
    return createHash('sha256').update(`${value}${salt}`).digest('hex');
  }
}
