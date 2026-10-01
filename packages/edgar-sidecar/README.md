# SEC ownership sidecar

The TypeScript core has no runtime dependency. This optional Python sidecar parses recorded Form 4 and 13F XML with the standard library. Live retrieval uses the MIT-licensed `edgartools` package; its license was read before integration. No upstream parser code was copied. Use an isolated environment and install the pinned version in requirements-live.txt before a live trial.

```sh
python3 -m unittest discover -s packages/edgar-sidecar/test -v
python3 packages/edgar-sidecar/ownership.py --form 4 --as-of YYYY-MM-DD --xml filing.xml --metadata metadata.json
python3 packages/edgar-sidecar/ownership.py --form 13F-HR --as-of YYYY-MM-DD --xml cover.xml --table holdings.xml --metadata metadata.json
```

Metadata includes `accession`, `filedAt`, `url`, `retrievedAt`, `licenceClass`, and for 13F the explicit original `valueUnit`: `USD` or `USD_THOUSANDS`. No value-unit guesses are permitted for recorded inputs. Live SEC access requires the owner's `GENINVESTOR_SEC_IDENTITY`; the sidecar never invents it. Real filing access remains unverified in this change.

Form 4 preserves derivative and non-derivative transactions, codes, missing prices and footnotes. It makes no sentiment inference. 13F preserves report period, filing availability, amendments, option types, security class and voting authority. It neither guesses tickers from CUSIPs nor infers transactions from a delayed snapshot. Raw XML and hashes remain in the local source payload; reporting-owner addresses are never put in the dashboard.

Limits: XML parser tests use synthetic fixtures; filing retrieval is not yet validated end to end. Large or multi-table filings fail closed. Amendments are separate evidence, never silently netted. Live 13F requires --value-unit after checking the actual submission. A date-based unit guess was rejected during review because real filings can deviate from it.
