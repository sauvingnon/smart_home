from cryptography import x509
from cryptography.x509.oid import NameOID
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives import serialization
from datetime import datetime, timedelta
import os

os.makedirs('certs', exist_ok=True)

private_key = rsa.generate_private_key(
    public_exponent=65537,
    key_size=2048,
    backend=default_backend()
)

subject = issuer = x509.Name([
    x509.NameAttribute(NameOID.COMMON_NAME, u'localhost'),
])

cert = x509.CertificateBuilder().subject_name(
    subject
).issuer_name(
    issuer
).public_key(
    private_key.public_key()
).serial_number(
    x509.random_serial_number()
).not_valid_before(
    datetime.utcnow()
).not_valid_after(
    datetime.utcnow() + timedelta(days=365)
).add_extension(
    x509.SubjectAlternativeName([
        x509.DNSName(u'localhost'),
        x509.DNSName(u'127.0.0.1'),
    ]),
    critical=False,
).sign(private_key, hashes.SHA256(), default_backend())

with open('certs/grafana.key', 'wb') as f:
    f.write(private_key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.TraditionalOpenSSL,
        encryption_algorithm=serialization.NoEncryption()
    ))

with open('certs/grafana.crt', 'wb') as f:
    f.write(cert.public_bytes(serialization.Encoding.PEM))

print('✅ Сертификаты созданы на 365 дней:')
print('   📄 certs/grafana.key')
print('   📄 certs/grafana.crt')
