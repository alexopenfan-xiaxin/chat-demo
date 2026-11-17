-- 每个用户自己的上游 key：明文只在注册时出现一次，库里只存 AES-GCM 密文。
-- quota 存下来是为了判断 unlimited（面板里 quota 0 = 不限额），不必每次问面板。
ALTER TABLE users ADD COLUMN upstream_key_enc TEXT;
ALTER TABLE users ADD COLUMN upstream_key_name TEXT;
ALTER TABLE users ADD COLUMN upstream_key_prefix TEXT;
ALTER TABLE users ADD COLUMN upstream_key_quota REAL;
