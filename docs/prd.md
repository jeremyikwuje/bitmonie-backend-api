# Bitmonie — Product Requirements Document (PRD)

**Version:** 1.0 — Lightning MVP  
**Last Updated:** 2025  
**Status:** Pre-development

---

## 1. Overview

### 1.1 Product Summary

Bitmonie is a crypto-backed instant Naira credit product for the Nigerian market. Customers lock Bitcoin (via Lightning Network) as collateral and receive Naira within seconds—**no forced KYC for loans up to N500,000**. Borrowers verify via email + crypto collateral; tier-1 KYC (BVN/NIN) is optional for smaller amounts and required only for loans exceeding N500,000. No crypto is sold. The loan is repaid in SAT (Lightning) or NGN, after which the locked SAT collateral is released to a customer-specified Lightning address.

### 1.2 Mission

> "Lock your Bitcoin. Get Naira instantly. No friction, no KYC delays — your collateral is your credential."

### 1.3 MVP Scope (v1.0, evolved)

- **Collateral:** SAT only via Lightning Network
- **Disbursement:** NGN to customer's bank account (no name verification required for ≤ N500k loans)
- **Repayment:** NGN bank transfer or SAT Lightning payment
- **Collateral Release:** SAT sent to customer's specified Lightning address on loan closure
- **KYC:** Email-verified only for ≤ N500k; BVN verification required for > N500k
- **Price Feed:** SAT/NGN, BTC/NGN, USDT/NGN
- **No wallet balances** — loan balances only
- **Privacy-forward:** Positioning around crypto collateral as the primary credential for privacy-conscious Bitcoiners

### 1.4 Out of Scope (v1.0)

- USDT / USDC collateral (v2)
- On-chain BTC collateral (v2)
- iPhone, MacBook, Car collateral (v3+)
- Yield / savings vault product (future)

---

## 2. User Personas

### 2.1 Persona A — The Privacy-Conscious HODL Borrower
**Name:** Shola, 31, Lagos  
**Profile:** Holds 0.07 BTC (~$3,000). Values privacy; doesn't want to dox savings to CBN or a bank. Needs N300,000 for business working capital for 10 days.  
**Goal:** Get Naira fast without surrendering BVN/NIN and risking account freeze.  
**Pain point:** Traditional banks ask for KYC docs; P2P takes days; crypto platforms can be exploited. Wants crypto-backed lending without the paperwork or surveillance.
**Key insight:** Crypto collateral IS the verification — they have an on-chain address; that's proof of custody.

### 2.2 Persona B — The Rate Watcher (Bitcoin Stacker)
**Name:** Emeka, 27, Abuja  
**Profile:** Stacks SAT monthly from remote work income. Rate volatility makes timing sales stressful. Wants to keep BTC but needs Naira on short notice.  
**Goal:** Access short-term NGN liquidity instantly, no KYC friction.  
**Pain point:** P2P selling takes hours, requires bank details anyway, and he regrets every sale when the rate jumps.

### 2.3 Persona C — The High-Value Borrower
**Name:** Funke, 44, Port Harcourt  
**Profile:** Business owner holding significant BTC. Needs N15M+ for a supply chain payment. Willing to provide KYC for large amounts; values speed over privacy.  
**Goal:** Large loan with white-glove service and fast approval (via KYC).  
**Entry point:** Get Quote page → WhatsApp/email follow-up from Bitmonie team.

---

## 3. User Stories

### 3.1 Authentication & Onboarding

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-01 | Visitor | Use the loan calculator without signing up | I can explore before committing |
| US-02 | New user | Sign up with email only (no password) | I can create an account instantly |
| US-03 | New user | Verify my email via OTP | My account is secure and I can proceed to borrowing |
| US-04 | New user (≤ N500k) | Borrow up to N500,000 without KYC | I can access Naira without surrendering BVN/NIN |
| US-05 | New user (> N500k) | Verify my identity with BVN for loans > N500k | I can borrow larger amounts with proper compliance |
| US-06 | User | Optionally verify with NIN as alternative to BVN | I have flexibility if BVN is unavailable |
| US-07 | User | Enable TOTP 2FA for account security | I can secure my account further (used for transaction step-up) |

### 3.2 Bank Account Management

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-07 | Verified user | Add a bank account | I can receive Naira disbursements |
| US-08 | Verified user | Add up to 5 bank accounts | I have flexibility in where I receive funds |
| US-09 | Verified user | Set a default bank account | Loans are disbursed there automatically |
| US-10 | Verified user | Remove a bank account | I can manage my linked accounts |
| US-11 | System | Validate bank account name matches BVN name | Only accounts in my name are accepted |

### 3.3 Loan Calculator (Public — No Auth Required)

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-12 | Visitor | Enter a SAT/BTC amount and see how much NGN I can borrow | I can make an informed decision |
| US-13 | Visitor | Enter an NGN amount and see how much SAT collateral I need | I can plan my collateral |
| US-14 | Visitor | See live SAT/NGN rate, daily fee, total fees, and liquidation price | Full transparency before I commit |
| US-15 | Visitor | Select loan duration (1–30 days) | I can see how fees change by duration |

### 3.4 Loan Checkout

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-16 | Email-verified user (≤ N500k) | Checkout a loan without KYC | I can borrow quickly without paperwork |
| US-17 | Email-verified user (> N500k) | Be prompted for KYC tier-1 at checkout if > N500k | Large loans are properly verified |
| US-18 | Verified user | See a final loan summary before confirming | I confirm exact terms before sending SAT |
| US-19 | Verified user | Receive a Lightning invoice to send SAT collateral | I can pay from my Lightning wallet |
| US-20 | Verified user | Have NGN credited to my designated bank account within 60 seconds of SAT confirmation | The promise of instant funding is kept |
| US-21 | Verified user | Receive a loan confirmation with all terms | I have a record of what I agreed to |

### 3.5 Loan Management

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-21 | Borrower | View all my active loans | I know what I owe and when |
| US-22 | Borrower | View all historical/closed loans | I have a full borrowing history |
| US-23 | Borrower | See SAT locked per loan | I know my collateral at all times |
| US-24 | Borrower | See accrued fees and outstanding balance | No surprise charges |
| US-25 | Borrower | Receive alerts when collateral approaches liquidation threshold | I can top up before losing collateral |

### 3.6 Loan Repayment

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-26 | Borrower | Repay my loan in NGN via bank transfer | I can use naira I have on hand |
| US-27 | Borrower | Repay my loan in SAT via Lightning | I can repay directly in crypto |
| US-28 | Borrower | Specify a Lightning address for collateral release before repaying | My SAT is returned exactly where I want it |
| US-29 | Borrower | Receive my SAT collateral back at the specified Lightning address upon full repayment | The full cycle is complete |
| US-30 | Borrower | Receive a repayment confirmation and loan closure receipt | I have records for my own bookkeeping |

### 3.7 Liquidation

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-31 | System | Monitor SAT/NGN rate continuously | Liquidation triggers are caught in real time |
| US-32 | System | Alert borrower at 120% collateral-to-loan ratio | They have a chance to act before liquidation |
| US-33 | System | Auto-liquidate at 110% collateral-to-loan ratio | The loan principal is always recoverable |
| US-34 | System | Send remaining collateral (after loan recovery) to borrower's Lightning address | Customer receives any surplus after liquidation |

### 3.8 Large Loan Enquiry

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-35 | High-value visitor | Submit a Get Quote form for loans above N10M | Bitmonie team can structure my facility |
| US-36 | High-value visitor | Be contacted within 2 hours on business days | My enquiry is handled seriously |

---

## 4. Functional Requirements

### 4.1 Loan Parameters (v1.0)

| Parameter | Value |
|-----------|-------|
| Minimum loan | N10,000 |
| Maximum loan (self-serve) | N10,000,000 |
| Maximum loan (manual) | Unlimited |
| LTV | 60% |
| Liquidation trigger | Collateral value = 110% of outstanding loan |
| Alert threshold | Collateral value = 120% of outstanding loan |
| Minimum duration | 1 day |
| Maximum duration | 30 days |
| Fee | N500 per $100 equivalent per day |
| Origination fee | N500 flat per loan |
| Fee timing | Charged upfront at loan creation |
| Collateral | SAT via Lightning Network |
| Disbursement | NGN to verified bank account |

### 4.2 Price Feeds

- Pairs: SAT/NGN, BTC/NGN, USDT/NGN
- Refresh interval: Every 60 seconds minimum, every 15 seconds during active loan monitoring
- Liquidation monitoring: Every 30 seconds for all active loans
- Feed failure behaviour: Pause new loan creation, continue monitoring existing loans with last known rate + staleness flag

### 4.3 KYC Requirements

**Tier-1 KYC (BVN/NIN) is OPTIONAL for loans ≤ N500,000:**
- Email verification alone is sufficient to checkout
- Crypto collateral (on-chain address + SAT lock) serves as the primary credential
- User can borrow and receive disbursement without BVN/NIN for amounts ≤ N500k

**Tier-1 KYC is MANDATORY for loans > N500,000:**
- BVN verification (primary)
- NIN verification (secondary)
- Bank account name must fuzzy-match BVN legal name (threshold: 85% similarity)
- One KYC per user — reuse across all loans

**Implementation note:** For loans ≤ N500k without KYC, disbursement account bank name verification is skipped. For loans > N500k or user-initiated KYC, full name-match validation applies.

### 4.4 Bank Account Rules

- Minimum: 1 account (required before first loan)
- Maximum: 5 accounts
- All accounts must pass name-match against BVN
- One account designated as default while any account of that kind exists
- Any account may be deleted, including the sole/default one; deleting the default auto-promotes the oldest remaining account of that kind (if any)

### 4.5 Notifications

| Trigger | Channel |
|---------|---------|
| Loan created | Email + in-app |
| NGN disbursed | Email + SMS + in-app |
| Collateral alert (120%) | Email + in-app + push (if mobile) |
| Liquidation triggered | Email + SMS + in-app |
| Repayment received | Email + in-app |
| Loan closed + collateral released | Email + in-app |
| Large loan enquiry received | Email to customer + internal Slack/email |

---

## 5. Non-Functional Requirements

### 5.1 Performance

- Loan calculator: < 200ms response (cached price feed)
- Loan checkout to NGN disbursement: < 60 seconds after SAT confirmation
- API response time (95th percentile): < 500ms
- Price feed staleness alert if not updated in > 2 minutes

### 5.2 Security

- All data encrypted at rest (AES-256)
- TLS 1.3 for all connections
- API keys stored in environment variables — never in codebase
- Lightning invoice secrets never logged
- BVN/NIN data encrypted in database, never returned raw in API responses
- Rate limiting on all public endpoints
- CSRF protection on all state-changing endpoints
- Audit log for all financial events (immutable append-only)

### 5.3 Availability

- Target uptime: 99.5%
- Liquidation monitor: must be running 24/7 — alerting if process dies
- Price feed failure: degrade gracefully, surface status to users

### 5.4 Compliance

- CBN KYC requirements met via BVN/NIN verification
- All loan terms displayed and acknowledged before disbursement
- Loan agreement PDF generated and stored per loan
- Audit trail maintained for all transactions

---

## 6. Page Map

```
/ (Homepage)
  └── Loan Calculator (public, no auth)
  └── CTA → Sign Up / Log In

/signup
/login
/verify-email
/forgot-password

/dashboard
  ├── /dashboard/loans          — Active + historical loans
  ├── /dashboard/loans/[id]     — Single loan detail
  ├── /dashboard/checkout       — Loan checkout flow
  └── /dashboard/settings
        ├── /profile            — Personal details, KYC status
        ├── /disbursement-accounts — Add/remove/default payout destinations (BANK / MOBILE_MONEY / CRYPTO_ADDRESS)
        └── /security           — Password, 2FA

/get-quote                      — Large loan enquiry form (public)
```

---

## 7. Success Metrics (90-day Post-Launch)

| Metric | Target |
|--------|--------|
| Loans originated | 200+ |
| Total NGN disbursed | N50M+ |
| Average loan duration | 5–10 days |
| Liquidation rate | < 5% of loans |
| Customer repayment rate | > 90% |
| Calculator-to-checkout conversion | > 15% |
| Time to disburse (p95) | < 60 seconds |
| NPS | > 50 |