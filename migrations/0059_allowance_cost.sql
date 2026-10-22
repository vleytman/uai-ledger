ALTER TABLE allowance_reservations ADD COLUMN allocated_cost_units numeric(38,0) NOT NULL DEFAULT 0 CHECK(allocated_cost_units>=0);
