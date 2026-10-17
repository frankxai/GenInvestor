import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parents[1]))
from ownership import parse_form4, parse_13f

META = {'accession': '0000000000-26-000001', 'filedAt': '2026-09-30', 'url': 'fixture://ownership', 'retrievedAt': '2026-10-01T00:00:00Z', 'licenceClass': 'sim_only'}
FORM4 = '''<ownershipDocument><documentType>4</documentType><periodOfReport>2026-09-28</periodOfReport><issuer><issuerCik>1</issuerCik><issuerTradingSymbol>DEMO</issuerTradingSymbol></issuer><nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common stock</value></securityTitle><transactionDate><value>2026-09-28</value></transactionDate><transactionCoding><transactionCode>F</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>25</value></transactionShares><transactionPricePerShare><value>10.5</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts><postTransactionAmounts><sharesOwnedFollowingTransaction><value>75</value></sharesOwnedFollowingTransaction></postTransactionAmounts><ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction></nonDerivativeTable><derivativeTable><derivativeTransaction><transactionDate><value>2026-09-28</value></transactionDate><transactionCoding><transactionCode>M</transactionCode></transactionCoding><transactionAmounts><transactionShares><value>20</value></transactionShares></transactionAmounts></derivativeTransaction></derivativeTable><footnotes><footnote id="F1">Tax withholding.</footnote></footnotes></ownershipDocument>'''
PRIMARY = '<edgarSubmission xmlns="urn:sec"><formData><coverPage><reportCalendarOrQuarter>06-30-2026</reportCalendarOrQuarter><isAmendment>true</isAmendment><amendmentInfo><amendmentType>NEW HOLDINGS</amendmentType></amendmentInfo></coverPage></formData></edgarSubmission>'
TABLE = '<informationTable xmlns="urn:sec"><infoTable><nameOfIssuer>Demo</nameOfIssuer><titleOfClass>COM</titleOfClass><cusip>000000001</cusip><value>100</value><shrsOrPrnAmt><sshPrnamt>40</sshPrnamt><sshPrnamtType>SH</sshPrnamtType></shrsOrPrnAmt><putCall>PUT</putCall><votingAuthority><Sole>30</Sole><Shared>10</Shared><None>0</None></votingAuthority></infoTable></informationTable>'
class OwnershipTests(unittest.TestCase):
    def test_form4_keeps_both_tables_and_codes(self):
        d = parse_form4(FORM4, META, '2026-09-30')
        self.assertEqual(len(d['payload']['transactions']), 2)
        self.assertEqual(d['payload']['transactions'][0]['code'], 'F')
        self.assertEqual(d['payload']['transactions'][1]['table'], 'derivative')
        self.assertEqual(d['payload']['transactions'][0]['shares'], 25)
        self.assertEqual(d['payload']['rawXml'], FORM4)
    def test_filing_date_is_the_availability_boundary(self):
        with self.assertRaises(ValueError): parse_form4(FORM4, META, '2026-09-29')
    def test_missing_price_is_unknown(self):
        self.assertIsNone(parse_form4(FORM4, META, '2026-09-30')['payload']['transactions'][1]['price'])
    def test_namespaces_units_and_amendments(self):
        d = parse_13f(PRIMARY, TABLE, {**META, 'valueUnit': 'USD_THOUSANDS'}, '2026-09-30')
        self.assertEqual(d['payload']['holdings'][0]['valueUsd'], 100000)
        self.assertEqual(d['payload']['holdings'][0]['putCall'], 'PUT')
        self.assertEqual(d['payload']['amendmentType'], 'NEW HOLDINGS')
        self.assertEqual(d['asOf'], '2026-06-30')
    def test_whole_dollar_unit_is_not_multiplied(self):
        self.assertEqual(parse_13f(PRIMARY, TABLE, {**META, 'valueUnit': 'USD'}, '2026-09-30')['payload']['holdings'][0]['valueUsd'], 100)
    def test_unknown_units_fail_closed(self):
        with self.assertRaises(ValueError): parse_13f(PRIMARY, TABLE, META, '2026-09-30')
    def test_xml_entities_and_nonfinite_values_are_refused(self):
        for xml in ['<!DOCTYPE x [<!ENTITY y "x">]><x/>', FORM4.replace('25', 'NaN')]:
            with self.assertRaises(ValueError): parse_form4(xml, META, '2026-09-30')
    def test_invalid_calendar_dates_fail_closed(self):
        with self.assertRaises(ValueError): parse_form4(FORM4, {**META, 'filedAt': '2026-02-30'}, '2026-09-30')
if __name__ == '__main__': unittest.main()
