import json
import os
import smtplib
import ssl
from email.message import EmailMessage
from html import escape
from pathlib import Path

REPORT_PATH = Path(os.environ.get('SYNC_REPORT_PATH', 'sync-report.json'))
SMTP_HOST = os.environ.get('SMTP_HOST', '')
SMTP_PORT_RAW = os.environ.get('SMTP_PORT', '').strip()
SMTP_PORT = int(SMTP_PORT_RAW) if SMTP_PORT_RAW else 587
SMTP_USERNAME = os.environ.get('SMTP_USERNAME', '')
SMTP_PASSWORD = os.environ.get('SMTP_PASSWORD', '')
SMTP_FROM = os.environ.get('SMTP_FROM', SMTP_USERNAME)
REPORT_TO = [x.strip() for x in os.environ.get('SYNC_REPORT_TO', '').split(',') if x.strip()]
RUN_URL = os.environ.get('GITHUB_RUN_URL', '')
SYNC_STEP_OUTCOME = os.environ.get('SYNC_STEP_OUTCOME', '')
PRICE_MARKUP = float(os.environ.get('PRICE_MARKUP', '0.17'))
MAX_PRICE_CHANGE_RATIO = float(os.environ.get('MAX_PRICE_CHANGE_RATIO', '0.50'))
PRICE_DRY_RUN = os.environ.get('PRICE_DRY_RUN', '1') != '0'

if REPORT_PATH.exists():
    with REPORT_PATH.open('r', encoding='utf-8') as f:
        data = json.load(f)
else:
    data = {
        'summary': {
            'productsChecked': 0,
            'inventoryUpdates': 0,
            'priceUpdates': 0,
            'priceWouldUpdate': 0,
            'priceParity': 0,
            'needReview': 1,
        },
        'pricing': {
            'markupPercent': PRICE_MARKUP * 100,
            'roundingRule': 'nearest whole euro',
            'maxPriceChangePercent': MAX_PRICE_CHANGE_RATIO * 100,
            'mode': 'DRY_RUN' if PRICE_DRY_RUN else 'LIVE',
        },
        'questionable': [{
            'product': 'Sync workflow',
            'status': 'FAILED',
            'error': f'Sync ended with outcome {SYNC_STEP_OUTCOME or "unknown"} before a structured report was created.',
        }],
        'changes': [],
    }

summary = data.get('summary', {})
pricing = data.get('pricing', {})
questionable = data.get('questionable', [])
changes = data.get('changes', [])

if not SMTP_HOST or not SMTP_USERNAME or not SMTP_PASSWORD or not SMTP_FROM or not REPORT_TO:
    print('Email report not sent because SMTP configuration is incomplete.')
    print('Required: SMTP_HOST, SMTP_USERNAME, SMTP_PASSWORD, SMTP_FROM, SYNC_REPORT_TO')
    raise SystemExit(0)

need_review = int(summary.get('needReview', 0) or 0)
actual_price_updates = int(summary.get('priceUpdates', 0) or 0)
would_price_updates = int(summary.get('priceWouldUpdate', 0) or 0)
inventory_updates = int(summary.get('inventoryUpdates', 0) or 0)
update_count = inventory_updates + actual_price_updates + would_price_updates
price_mode = pricing.get('mode', 'UNKNOWN')

if need_review:
    subject = f"SolarMeister Sync Report: {update_count} Updates, {need_review} Need Review"
elif price_mode == 'DRY_RUN':
    subject = f"SolarMeister Price Audit: {would_price_updates} Differences, 0 Need Review"
else:
    subject = 'SolarMeister Sync Report: Complete, No Issues'

headline = 'NO ACTION NEEDED' if need_review == 0 else 'ACTION NEEDED'

def eur(value):
    if value is None or value == '':
        return 'n/a'
    try:
        return f"€{float(value):,.2f}".replace(',', 'X').replace('.', ',').replace('X', '.')
    except Exception:
        return str(value)

def item_text(item):
    lines = [item.get('product', 'Unknown product')]
    if item.get('variant'):
        lines.append(f"Variant: {item['variant']}")
    if item.get('sourcePrice') is not None:
        lines.append(f"Balkonstrom price: {eur(item['sourcePrice'])}")
    if item.get('currentPrice') is not None:
        lines.append(f"Current SolarMeister price: {eur(item['currentPrice'])}")
    if item.get('targetPrice') is not None:
        lines.append(f"Calculated SolarMeister price: {eur(item['targetPrice'])}")
    if item.get('differencePct'):
        lines.append(f"Difference: {item['differencePct']}")
    if item.get('supplier'):
        lines.append(f"Supplier availability: {item['supplier']}")
    if item.get('shopifyPolicy'):
        lines.append(f"SolarMeister policy: {item['shopifyPolicy']}")
    if item.get('status'):
        lines.append(f"Status: {item['status']}")
    if item.get('error'):
        lines.append(f"Reason: {item['error']}")
    return '\n'.join(lines)

plain = [
    headline,
    '',
    'SolarMeister Sync Report',
    f"Products checked: {summary.get('productsChecked', 0)}",
    f"Inventory updates: {inventory_updates}",
    f"Price updates: {actual_price_updates}",
    f"Price differences in dry run: {would_price_updates}",
    f"Price items already in parity: {summary.get('priceParity', 0)}",
    f"Need review: {need_review}",
    f"Active markup: {pricing.get('markupPercent', 0):g}%",
    f"Rounding rule: {pricing.get('roundingRule', 'nearest whole euro')}",
    f"Price safety threshold: {pricing.get('maxPriceChangePercent', 0):g}%",
    f"Price mode: {price_mode}",
    '',
]

if price_mode == 'DRY_RUN':
    plain.extend(['DRY RUN. No prices were changed.', ''])

if questionable:
    plain.extend(['QUESTIONABLE / NEEDS REVIEW', ''])
    for i, item in enumerate(questionable, 1):
        plain.extend([f"{i}. {item_text(item)}", ''])

if changes:
    plain.extend(['CHANGES / DIFFERENCES', ''])
    for i, item in enumerate(changes, 1):
        plain.extend([f"{i}. {item_text(item)}", ''])

if RUN_URL:
    plain.extend(['GitHub Run', RUN_URL])

html_parts = [
    '<div style="font-family:Arial,sans-serif;max-width:760px;margin:auto;color:#111">',
    f'<div style="font-size:24px;font-weight:700;margin-bottom:18px">{escape(headline)}</div>',
    '<h2 style="margin-bottom:6px">SolarMeister Sync Report</h2>',
    '<table style="border-collapse:collapse;width:100%;margin:12px 0 22px">',
]

summary_rows = [
    ('Products checked', summary.get('productsChecked', 0)),
    ('Inventory updates', inventory_updates),
    ('Price updates', actual_price_updates),
    ('Price differences in dry run', would_price_updates),
    ('Price items already in parity', summary.get('priceParity', 0)),
    ('Need review', need_review),
    ('Active markup', f"{pricing.get('markupPercent', 0):g}%"),
    ('Rounding rule', pricing.get('roundingRule', 'nearest whole euro')),
    ('Price safety threshold', f"{pricing.get('maxPriceChangePercent', 0):g}%"),
    ('Price mode', price_mode),
]
for label, value in summary_rows:
    html_parts.append(f'<tr><td style="padding:7px;border-bottom:1px solid #ddd"><b>{escape(str(label))}</b></td><td style="padding:7px;border-bottom:1px solid #ddd">{escape(str(value))}</td></tr>')
html_parts.append('</table>')

if price_mode == 'DRY_RUN':
    html_parts.append('<p style="font-weight:700">DRY RUN. No prices were changed.</p>')

if questionable:
    html_parts.append('<h3>QUESTIONABLE / NEEDS REVIEW</h3>')
    for item in questionable:
        html_parts.append('<div style="padding:12px;border:1px solid #bbb;margin:10px 0">')
        html_parts.append('<br>'.join(escape(line) for line in item_text(item).splitlines()))
        html_parts.append('</div>')

if changes:
    html_parts.append('<h3>CHANGES / DIFFERENCES</h3>')
    for item in changes:
        html_parts.append('<div style="padding:10px 0;border-bottom:1px solid #ddd">')
        html_parts.append('<br>'.join(escape(line) for line in item_text(item).splitlines()))
        html_parts.append('</div>')

if RUN_URL:
    html_parts.append(f'<p style="margin-top:24px"><a href="{escape(RUN_URL)}">Open GitHub run</a></p>')
html_parts.append('</div>')

msg = EmailMessage()
msg['Subject'] = subject
msg['From'] = SMTP_FROM
msg['To'] = ', '.join(REPORT_TO)
msg.set_content('\n'.join(plain))
msg.add_alternative(''.join(html_parts), subtype='html')

context = ssl.create_default_context()
if SMTP_PORT == 465:
    with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context, timeout=30) as server:
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg)
else:
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT, timeout=30) as server:
        server.ehlo()
        server.starttls(context=context)
        server.ehlo()
        server.login(SMTP_USERNAME, SMTP_PASSWORD)
        server.send_message(msg)

print(f"Sync report emailed to {', '.join(REPORT_TO)}")
