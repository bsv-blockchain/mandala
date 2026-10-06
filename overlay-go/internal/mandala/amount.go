package mandala

import (
	"fmt"
	"math"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// MaxSafeAmount is 2^53-1, the Mandala cap on every amount, sum and supply (D §3.4) and the largest
// integer a BSON double (the TS driver's `number`) holds exactly.
const MaxSafeAmount uint64 = 9007199254740991

// Amount is an integer amount persisted as a BSON double (D §6.6), the TS driver's shape for a
// `number`. It reads int32, int64 or an integral double within ±(2^53-1), since js-bson writes a
// small safe integer as int32 (F/ts-storage §1.3); a fractional, non-finite or larger double is an
// error. JSON is a plain integer.
type Amount int64

// MarshalBSONValue writes the amount as a BSON double.
func (a Amount) MarshalBSONValue() (byte, []byte, error) {
	t, data, err := bson.MarshalValue(float64(a))
	if err != nil {
		return 0, nil, err
	}
	return byte(t), data, nil
}

// UnmarshalBSONValue reads an int32, int64 or integral safe double.
func (a *Amount) UnmarshalBSONValue(t byte, data []byte) error {
	switch bson.Type(t) {
	case bson.TypeInt32:
		var v int32
		if err := bson.UnmarshalValue(bson.TypeInt32, data, &v); err != nil {
			return err
		}
		*a = Amount(v)
	case bson.TypeInt64:
		var v int64
		if err := bson.UnmarshalValue(bson.TypeInt64, data, &v); err != nil {
			return err
		}
		*a = Amount(v)
	case bson.TypeDouble:
		var f float64
		if err := bson.UnmarshalValue(bson.TypeDouble, data, &f); err != nil {
			return err
		}
		if math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) || math.Abs(f) > float64(MaxSafeAmount) {
			return fmt.Errorf("amount: %v is not a safe integer", f)
		}
		*a = Amount(int64(f))
	default:
		return fmt.Errorf("amount: unsupported bson type %v", bson.Type(t))
	}
	return nil
}
