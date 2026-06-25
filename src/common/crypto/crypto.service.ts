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
  private kyc_id_pepper!: string;

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

    const pepper_hex = this.config.get<string>('KYC_ID_HASH_PEPPER');
    if (!pepper_hex) {
      throw new Error('KYC_ID_HASH_PEPPER is required');
    }
    if (Buffer.from(pepper_hex, 'hex').length !== 32) {
      throw new Error('KYC_ID_HASH_PEPPER must be 32 bytes (64 hex chars)');
    }
    this.kyc_id_pepper = pepper_hex;
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

  // Deterministic hash for BVN/NIN/passport/drivers-license numbers. Same input
  // → same output, so a unique index on the column enforces "one user per ID".
  // The pepper is server-side only (not stored in the DB), so a row-level leak
  // of `id_number_hash` does not let an attacker brute-force the 11-digit
  // BVN/NIN keyspace — they would also need the pepper from app secrets.
  hashKycIdNumber(id_number: string): string {
    return createHash('sha256').update(`${this.kyc_id_pepper}${id_number}`).digest('hex');
  }
}
