import { Account, Bytes, bytes, uint64 } from '@algorandfoundation/algorand-typescript'
import { itob, sha512_256 } from '@algorandfoundation/algorand-typescript/op'

export function sponsorAddress(appId: uint64, ali: Account, xin: Account): Account {
  let remaining = appId
  let encoded = Bytes('')
  while (remaining >= 128) {
    const next: uint64 = (remaining % 128) + 128
    encoded = encoded.concat(itob(next).slice(7, 8))
    remaining = remaining / 128
  }
  encoded = encoded.concat(itob(remaining).slice(7, 8))
  const program: bytes = Bytes.fromHex('0a200501020005').concat(encoded)
    .concat(Bytes.fromHex('260220')).concat(ali.bytes)
    .concat(Bytes.fromHex('20')).concat(xin.bytes)
    .concat(Bytes.fromHex('282921043204231244311614443101144431203203124431162208494e02493810810612444938184f02124424c21a498004dda05a7a1241001f4b013819144431093203124431074b041244310832013200230b0812442243498004c5ba2d44124100134b0138192512443108144431094b03124422434980044801e8291240000b49800466671879124100134b0138192512443108144431094b04124422432443'))
  return Account(sha512_256(Bytes('Program').concat(program)))
}
