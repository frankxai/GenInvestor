"""Read-only SEC ownership sidecar. Original parser; edgartools handles live retrieval.
No network at import time. Raw documents remain in the user's local evidence store.
"""
import argparse
import hashlib
import json
import math
import os
import sys
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
import xml.etree.ElementTree as ET


def xml_root(text):
    if len(text) > 20_000_000 or '<!DOCTYPE' in text.upper() or '<!ENTITY' in text.upper():
        raise ValueError('Unsafe or oversized XML')
    root = ET.fromstring(text)
    for e in root.iter():
        e.tag = e.tag.rsplit('}', 1)[-1]
    return root


def text_at(root, path, default=None):
    e = root.find(path)
    return e.text.strip() if e is not None and e.text and e.text.strip() else default


def numeric(root, path):
    text = text_at(root, path)
    if text is None:
        return None
    try:
        decimal = Decimal(text.replace(',', ''))
        value = float(decimal)
        if not math.isfinite(value) or abs(value) > 9_007_199_254_740_991:
            raise ValueError('Nonfinite or unsafe numeric value')
        return int(decimal) if decimal == decimal.to_integral_value() else value
    except InvalidOperation as exc:
        raise ValueError('Invalid numeric field') from exc


def calendar(text):
    if not text:
        raise ValueError('Missing date')
    if len(text) == 10 and text[2] == '-':
        text = datetime.strptime(text, '%m-%d-%Y').date().isoformat()
    return date.fromisoformat(text).isoformat()


def envelope(meta, cutoff, period, payload):
    filed = calendar(meta['filedAt'])
    cutoff = calendar(cutoff)
    if filed > cutoff:
        raise ValueError('Filing was unavailable at the cutoff')
    if calendar(period) > filed:
        raise ValueError('Report period is after filing date')
    url = meta['url']
    if not (url.startswith('https://www.sec.gov/Archives/edgar/data/') or url.startswith('fixture://')):
        raise ValueError('Expected SEC archive URL or explicitly synthetic fixture')
    payload.update(accession=meta['accession'], filedAt=filed, knownAsOf=cutoff)
    return {'provider': 'edgartools-ownership', 'url': url, 'asOf': calendar(period), 'retrievedAt': meta['retrievedAt'], 'licenceClass': meta.get('licenceClass', 'public'), 'delayedBySeconds': 0, 'payload': payload}


def parse_form4(xml, meta, cutoff):
    root = xml_root(xml)
    form = text_at(root, 'documentType')
    if form not in ('4', '4/A'):
        raise ValueError('Expected Form 4 or amendment')
    rows = []
    for table in ('nonDerivative', 'derivative'):
        for row in root.findall(f'{table}Table/{table}Transaction'):
            rows.append({'table': 'non-derivative' if table == 'nonDerivative' else 'derivative',
                'security': text_at(row, 'securityTitle/value'),
                'transactionDate': calendar(text_at(row, 'transactionDate/value')),
                'code': text_at(row, 'transactionCoding/transactionCode'),
                'acquiredDisposed': text_at(row, 'transactionAmounts/transactionAcquiredDisposedCode/value'),
                'shares': numeric(row, 'transactionAmounts/transactionShares/value'),
                'price': numeric(row, 'transactionAmounts/transactionPricePerShare/value'),
                'sharesAfter': numeric(row, 'postTransactionAmounts/sharesOwnedFollowingTransaction/value'),
                'ownership': text_at(row, 'ownershipNature/directOrIndirectOwnership/value'),
                'footnoteIds': [e.attrib.get('id') for e in row.iter('footnoteId')]})
    payload = {'form': form, 'ticker': text_at(root, 'issuer/issuerTradingSymbol'), 'issuerCik': text_at(root, 'issuer/issuerCik'),
        'transactions': rows, 'footnotes': {e.attrib['id']: ''.join(e.itertext()).strip() for e in root.iter('footnote')},
        'rawXml': xml, 'rawSha256': hashlib.sha256(xml.encode()).hexdigest(),
        'limits': ['Transaction codes are preserved; tax withholding and awards are not market sentiment.', 'No automatic aggregation across owners or amendments.']}
    return envelope(meta, cutoff, text_at(root, 'periodOfReport'), payload)


def parse_13f(primary, table, meta, cutoff):
    root, info = xml_root(primary), xml_root(table)
    unit = meta.get('valueUnit')
    if unit not in ('USD', 'USD_THOUSANDS'):
        raise ValueError('Explicit original value unit required')
    multiplier = 1 if unit == 'USD' else 1000
    rows = []
    for row in info.iter('infoTable'):
        value = numeric(row, 'value')
        if value is None or value < 0:
            raise ValueError('Missing or negative holding value')
        usd = value * multiplier
        if abs(usd) > 9_007_199_254_740_991:
            raise ValueError('Unsafe holding value')
        rows.append({'issuer': text_at(row, 'nameOfIssuer'), 'securityClass': text_at(row, 'titleOfClass'), 'cusip': text_at(row, 'cusip'),
            'reportedValue': value, 'valueUsd': usd, 'shares': numeric(row, 'shrsOrPrnAmt/sshPrnamt'),
            'shareType': text_at(row, 'shrsOrPrnAmt/sshPrnamtType'), 'putCall': text_at(row, 'putCall'),
            'discretion': text_at(row, 'investmentDiscretion'), 'otherManager': text_at(row, 'otherManager'),
            'votingSole': numeric(row, 'votingAuthority/Sole'), 'votingShared': numeric(row, 'votingAuthority/Shared'), 'votingNone': numeric(row, 'votingAuthority/None')})
    if not rows:
        raise ValueError('No information table rows')
    cover = root.find('.//coverPage')
    if cover is None:
        raise ValueError('Missing 13F cover page')
    payload = {'form': text_at(root, 'headerData/submissionType', '13F-HR'), 'holdings': rows,
        'isAmendment': text_at(cover, 'isAmendment') == 'true', 'amendmentType': text_at(cover, 'amendmentInfo/amendmentType'),
        'valueUnit': unit, 'rawPrimaryXml': primary, 'rawInformationTableXml': table,
        'rawPrimarySha256': hashlib.sha256(primary.encode()).hexdigest(), 'rawInformationTableSha256': hashlib.sha256(table.encode()).hexdigest(),
        'limits': ['Reported holdings are a delayed snapshot, not current positions.', 'New-holdings amendments must not replace the original report.', 'No CUSIP-to-ticker guesses or inferred transactions.']}
    return envelope(meta, cutoff, text_at(cover, 'reportCalendarOrQuarter'), payload)


def fetch_live(identifier, form, cutoff, limit, value_unit=None):
    identity = os.environ.get('GENINVESTOR_SEC_IDENTITY')
    if not identity:
        raise ValueError('GENINVESTOR_SEC_IDENTITY is required; no identity is invented')
    from edgar import Company, set_identity
    set_identity(identity)
    filings = Company(identifier).get_filings(form=['4', '4/A'] if form == '4' else ['13F-HR', '13F-HR/A'], filing_date=f':{calendar(cutoff)}').head(limit)
    data = []
    for filing in filings:
        meta = {'accession': filing.accession_no, 'filedAt': str(filing.filing_date), 'url': filing.document.url,
            'retrievedAt': datetime.now(timezone.utc).isoformat(), 'licenceClass': 'public'}
        primary = filing.xml()
        if form == '4':
            data.append(parse_form4(primary, meta, cutoff))
        else:
            attachments = [a for a in filing.attachments if a.document_type == 'INFORMATION TABLE' and a.document.lower().endswith('.xml')]
            if len(attachments) != 1:
                raise ValueError('Expected exactly one XML information table; no partial portfolio emitted')
            if value_unit not in ('USD', 'USD_THOUSANDS'):
                raise ValueError('Live 13F requires an explicit source-verified value unit; dates do not prove units')
            meta['valueUnit'] = value_unit
            data.append(parse_13f(primary, attachments[0].download(), meta, cutoff))
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--form', choices=['4', '13F-HR'], required=True)
    parser.add_argument('--as-of', required=True)
    parser.add_argument('--identifier')
    parser.add_argument('--limit', type=int, default=10)
    parser.add_argument('--xml')
    parser.add_argument('--table')
    parser.add_argument('--metadata')
    parser.add_argument('--value-unit', choices=['USD', 'USD_THOUSANDS'])
    args = parser.parse_args()
    if not 1 <= args.limit <= 100:
        parser.error('limit must be between 1 and 100')
    if args.xml:
        meta = json.loads(Path(args.metadata).read_text())
        primary = Path(args.xml).read_text()
        data = [parse_form4(primary, meta, args.as_of) if args.form == '4' else parse_13f(primary, Path(args.table).read_text(), meta, args.as_of)]
    elif args.identifier:
        data = fetch_live(args.identifier, args.form, args.as_of, args.limit, args.value_unit)
    else:
        parser.error('provide recorded XML and metadata or an identifier')
    print(json.dumps(data, allow_nan=False))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Never echo provider exceptions: they may contain the user's SEC identity.
        print('Ownership ingestion failed; inspect local configuration and filing format.', file=sys.stderr)
        sys.exit(1)
