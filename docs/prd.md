# Bitmonie — Product Requirements Document (PRD)

**Version:** 1.0 — Lightning MVP  
**Last Updated:** 2025  
**Status:** Pre-development

---

## 1. Overview

### 1.1 Product Summary

Bitmonie is a crypto-backed instant Naira credit product for the Nigerian market. Customers lock Bitcoin (via Lightning Network) as collateral and receive Naira to their verified bank account within seconds. No crypto is sold. The loan is repaid in SAT (Lightning) or NGN, after which the locked SAT collateral is released to a customer-specified Lightning address.

### 1.2 Mission

> "Lock your Bitcoin. Get Naira instantly. Keep your upside."

### 1.3 MVP Scope (v1.0)

- **Collateral:** SAT only via Lightning Network
- **Disbursement:** NGN to customer's default bank account
- **Repayment:** NGN bank transfer or SAT Lightning payment
- **Collateral Release:** SAT sent to customer's specified Lightning address on loan closure
- **KYC:** BVN verification
- **Price Feed:** SAT/NGN, BTC/NGN, USDT/NGN
- **No wallet balances** — loan balances only

### 1.4 Out of Scope (v1.0)

- USDT / USDC collateral (v2)
- On-chain BTC collateral (v2)
- iPhone, MacBook, Car collateral (v3+)
- Yield / savings vault product (future)

---

## 2. User Personas

### 2.1 Persona A — The HODL Borrower
**Name:** Shola, 31, Lagos  
**Profile:** Holds 0.07 BTC (~$3,000). Believes NGN will weaken further. Needs N300,000 for business working capital for 10 days. Does not want to sell BTC and miss a potential N20+ rate appreciation.  
**Goal:** Get Naira fast without losing BTC exposure.  
**Pain point:** Every other option requires selling crypto or waiting days for bank loans.

### 2.2 Persona B — The Rate Watcher
**Name:** Emeka, 27, Abuja  
**Profile:** Stacks SAT monthly from remote work income. Rate volatility makes timing sales stressful.  
**Goal:** Access short-term NGN liquidity when needed without market timing pressure.  
**Pain point:** P2P selling takes time, fees are unpredictable, and he regrets every sale when rate jumps.

### 2.3 Persona C — The High-Value Borrower
**Name:** Funke, 44, Port Harcourt  
**Profile:** Business owner holding significant BTC. Needs N15M+ for a supply chain payment.  
**Goal:** Large loan with white-glove service.  
**Entry point:** Get Quote page → WhatsApp/email follow-up from Bitmonie team.

---

## 3. User Stories

### 3.1 Authentication & Onboarding

| ID | As a... | I want to... | So that... |
|----|---------|--------------|------------|
| US-01 | Visitor | Use the loan calculator without signing up | I can explore before committing |
| US-02 | New user | Sign up with email and password | I can create an account |
| US-03 | New user | Verify my identity with BVN | My bank account can be validated and disbursement is legal |
| US-04 | New user | Alternatively verify with NIN or Passport | I have options if BVN is unavailable |
| US-05 | User | Receive email OTP for login | My account is secure without passwords alone |
| US-06 | User | Enable 2FA (TOTP) | I can secure my account further |

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
| US-16 | Verified user | Checkout a loan from the calculator | The flow is seamless from quote to funding |
| US-17 | Verified user | See a final loan summary before confirming | I confirm exact terms before sending SAT |
| US-18 | Verified user | Receive a Lightning invoice to send SAT collateral | I can pay from my Lightning wallet |
| US-19 | Verified user | Have NGN credited to my default bank account within 60 seconds of SAT confirmation | The promise of instant funding is kept |
| US-20 | Verified user | Receive a loan confirmation with all terms | I have a record of what I agreed to |

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
| Minimum loan | N50,000 |
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

- BVN verification (primary)
- NIN verification (secondary)
- Passport (manual review fallback)
- Bank account name must fuzzy-match BVN legal name (threshold: 85% similarity)
- One KYC per user — reuse across all loans

### 4.4 Bank Account Rules

- Minimum: 1 account (required before first loan)
- Maximum: 5 accounts
- All accounts must pass name-match against BVN
- One account designated as default at all times
- Default cannot be deleted unless another is promoted first

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