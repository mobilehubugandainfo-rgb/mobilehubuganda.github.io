-- Table for Voucher Codes
CREATE TABLE IF NOT EXISTS vouchers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    package_type TEXT NOT NULL, 
    status TEXT CHECK(status IN ('unused', 'assigned', 'used')) DEFAULT 'unused',
    device_id TEXT, -- Renamed from mac_address for consistency
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME,
    used_at DATETIME,
    transaction_id TEXT, -- Linked to transactions.tracking_id
    notes TEXT
);

-- Table for Payments
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tracking_id TEXT UNIQUE NOT NULL,
    pesapal_transaction_id TEXT,
    package_type TEXT,
    amount INTEGER,
    phone_number TEXT,
    email TEXT,
    status TEXT CHECK(status IN ('PENDING', 'COMPLETED', 'FAILED', 'CANCELLED')) DEFAULT 'PENDING',
    voucher_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    updated_at DATETIME,
    notes TEXT,
    FOREIGN KEY (voucher_id) REFERENCES vouchers(id) ON DELETE SET NULL
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vouchers_code ON vouchers(code);
CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
CREATE INDEX IF NOT EXISTS idx_vouchers_transaction_id ON vouchers(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transactions_tracking ON transactions(tracking_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);