/** Synthetic fixtures only. Balances use integer cents to avoid rounding errors. */
export interface Member {
  id: string;
  name: string;
  savingsCents: number;
}

export const members: readonly Member[] = [
  { id: "12345", name: "Alex Morgan (Demo)", savingsCents: 824075 },
  { id: "23456", name: "Jamie Rivera (Demo)", savingsCents: 1560320 },
  { id: "34567", name: "Taylor Chen (Demo)", savingsCents: 95000 }
];

export function findMember(id: string): Member | undefined {
  return members.find((member) => member.id === id);
}
