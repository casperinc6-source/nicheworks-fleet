// Official unclaimed-property programs.
//
// Per-state URLs were taken from the official NAUPA master finder
// (https://unclaimed.org/search/) — the association OF the state programs —
// not from aggregators, and spot-verified live. Liveness can be re-checked
// any time with: node scripts/check-links.mjs
//
// LEGAL NOTE: searching and claiming via these official state programs is
// FREE. Never pay a "finder" more than the small statutory commission some
// states allow, and never use a paid aggregator when the state is free.

const NAUPA = 'https://unclaimed.org/search/';
const MISSINGMONEY = 'https://www.missingmoney.com/';

// Two-letter code, name, official program URL, MissingMoney (multi-state) member.
const STATES = [
  ['AL', 'Alabama',              'https://alabama.findyourunclaimedproperty.com/',        true],
  ['AK', 'Alaska',               'http://treasury.dor.alaska.gov/Unclaimed-Property.aspx', true],
  ['AZ', 'Arizona',              'https://azdor.gov/unclaimed-property/',                 true],
  ['AR', 'Arkansas',             'https://auditor.ar.gov/',                               true],
  ['CA', 'California',           'https://ucpi.sco.ca.gov/',                              true],
  ['CO', 'Colorado',             'https://colorado.findyourunclaimedproperty.com/',       true],
  ['CT', 'Connecticut',          'https://ctbiglist.gov/',                                true],
  ['DE', 'Delaware',             'https://unclaimedproperty.delaware.gov/',               true],
  ['DC', 'District of Columbia', 'https://dc.findyourunclaimedproperty.com/',             true],
  ['FL', 'Florida',              'https://fltreasurehunt.gov/',                           true],
  ['GA', 'Georgia',              'https://dor.georgia.gov/unclaimed-property-program',    true],
  ['HI', 'Hawaii',               'https://budget.hawaii.gov/finance/unclaimedproperty/',  true],
  ['ID', 'Idaho',                'https://yourmoney.idaho.gov/',                          true],
  ['IL', 'Illinois',             'https://icash.illinoistreasurer.gov/',                  true],
  ['IN', 'Indiana',              'https://indianaunclaimed.gov/',                         true],
  ['IA', 'Iowa',                 'https://www.greatiowatreasurehunt.gov/',                true],
  ['KS', 'Kansas',               'https://kansascash.ks.gov/',                            true],
  ['KY', 'Kentucky',             'https://treasury.ky.gov/Pages/index.aspx',              true],
  ['LA', 'Louisiana',            'http://LaCashClaim.org/',                               true],
  ['ME', 'Maine',                'https://maineunclaimedproperty.gov/',                   true],
  ['MD', 'Maryland',             'https://www.marylandtaxes.gov/unclaimed-property/index.php', true],
  ['MA', 'Massachusetts',        'https://www.findmassmoney.com/',                        true],
  ['MI', 'Michigan',             'https://unclaimedproperty.michigan.gov/',               true],
  ['MN', 'Minnesota',            'https://mn.gov/commerce/consumers/your-money/find-missing-money/', true],
  ['MS', 'Mississippi',          'https://treasury.ms.gov/for-citizens/unclaimed-property/', true],
  ['MO', 'Missouri',             'https://treasurer.mo.gov/UnclaimedProperty/',           true],
  ['MT', 'Montana',              'https://mtrevenue.gov/',                                true],
  ['NE', 'Nebraska',             'https://treasurer.nebraska.gov/up/',                    true],
  ['NV', 'Nevada',               'http://www.nevadatreasurer.gov/Unclaimed_Property/UP_Home/', true],
  ['NH', 'New Hampshire',        'https://newhampshire.findyourunclaimedproperty.com/',   true],
  ['NJ', 'New Jersey',           'https://www.unclaimedproperty.nj.gov/',                 true],
  ['NM', 'New Mexico',           'http://www.tax.newmexico.gov/Individuals/search-unclaimed-property.aspx', true],
  ['NY', 'New York',             'https://www.osc.state.ny.us/ouf/index.htm',             true],
  ['NC', 'North Carolina',       'https://www.nccash.com/',                               true],
  ['ND', 'North Dakota',         'https://www.land.nd.gov/UnclaimedProperty/',            true],
  ['OH', 'Ohio',                 'https://unclaimedfunds.ohio.gov/',                      true],
  ['OK', 'Oklahoma',             'https://www.oktreasure.com/',                           true],
  ['OR', 'Oregon',               'https://oregon.findyourunclaimedproperty.com/',         true],
  ['PA', 'Pennsylvania',         'https://www.patreasury.gov/',                           true],
  ['RI', 'Rhode Island',         'https://findrimoney.com/',                              true],
  ['SC', 'South Carolina',       'https://www.treasurer.sc.gov/what-we-do/for-citizens/unclaimed-property-program/', true],
  ['SD', 'South Dakota',         'https://southdakota.findyourunclaimedproperty.com/',    true],
  ['TN', 'Tennessee',            'https://treasury.tn.gov/Unclaimed-Property/Claim-Unclaimed-Property/Find-Your-Missing-Money', true],
  ['TX', 'Texas',                'https://claimittexas.org/',                             true],
  ['UT', 'Utah',                 'https://mycash.utah.gov/',                              true],
  ['VT', 'Vermont',              'https://www.vermonttreasurer.gov/content/unclaimed-property', true],
  ['VA', 'Virginia',             'https://vamoneysearch.org/',                            true],
  ['WA', 'Washington',           'https://ucp.dor.wa.gov/',                               true],
  ['WV', 'West Virginia',        'https://www.wvunclaimedproperty.gov/',                  true],
  ['WI', 'Wisconsin',            'https://www.revenue.wi.gov/Pages/UnclaimedProperty/Home.aspx', true],
  ['WY', 'Wyoming',              'https://statetreasurer.wyo.gov/unclaimed-property/',    true],
];

// Government surplus & seized-goods auctions — the legal way to buy
// abandoned cars, equipment, and seized property.
const AUCTIONS = [
  ['GovDeals',              'https://www.govdeals.com/en/automobiles-cars', 'The big municipal marketplace: city and county surplus, abandoned/impounded vehicles, heavy equipment. Most US cities sell here. (May block scripted checks — fine in a browser.)'],
  ['GSA Auctions',          'https://gsaauctions.gov/',                     'Federal fleet + seized property: cars, trucks, boats, aircraft, real estate.'],
  ['USA.gov vehicle hub',   'https://www.usa.gov/car-auctions',             "The government's own index of vehicle auction sources — start here to find your state's program."],
  ['USA.gov money hub',     'https://www.usa.gov/unclaimed-money',          'Official federal index of money owed to you: pensions, tax refunds, bank failures, insurance.'],
  ['State consumer offices','https://www.usa.gov/state-consumer',          'Every state consumer office links to local impound/surplus sales. Scroll to your state.'],
  ['Federal real estate',   'https://realestatesales.gov/',                 'Official portal for surplus and seized federal real estate — houses and land, sold at auction.'],
];

module.exports = { STATES, AUCTIONS, NAUPA, MISSINGMONEY };
