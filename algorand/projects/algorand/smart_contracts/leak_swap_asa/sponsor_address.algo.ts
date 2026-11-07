import { Account, Bytes, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import { itob, sha512_256 } from '@algorandfoundation/algorand-typescript/op'

export function asaSponsorAddress(appId: uint64, ali: Account, xin: Account): Account {
  let remaining = appId
  let encoded = Bytes('')
  while (remaining >= 128) {
    const next: uint64 = (remaining % 128) + 128
    encoded = encoded.concat(itob(next).slice(7, 8))
    remaining = remaining / 128
  }
  encoded = encoded.concat(itob(remaining).slice(7, 8))
  const program: bytes = Bytes.fromHex('0a200501000203')
    .concat(encoded)
    .concat(Bytes.fromHex('260220'))
    .concat(ali.bytes)
    .concat(Bytes.fromHex('20'))
    .concat(xin.bytes)
    .concat(
      Bytes.fromHex(
        '234980004921042829320424124000073204251241010d2244311614443101144431203203124432042209494506493810810612444938184b0412444938203203124423c21a4945078004dda05a7a1241002c32042412444b044938004b03494e0312443819144431071244310832013200240b08124431093203124422434b058004dda88be3124945054000184b0580049ee84c011240000c4b058004084e7c581241007a22444a4b054d4945084b05494e0238004b0112444c3819810512443108144431074b0112443109124432042512410040223810810412442238004b07124100362238144b071241002d22442238121444223801144422381532031241001422381332031241000b22442238203203124422432342fff22342ffd02342ff832342fef0',
      ),
    )
  return Account(sha512_256(Bytes('Program').concat(program)))
}
