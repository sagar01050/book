# app.py
from flask import Flask, request, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
import jwt
import datetime
from functools import wraps
import io
import base64
import qrcode
from sqlalchemy import text, inspect
import json  # NEW

# -------------- CONFIG --------------
app = Flask(__name__)
# CORS: explicitly allow Authorization header and localhost origins
CORS(app,
     resources={r"/api/*": {"origins": ["http://localhost:5500",
                                        "http://127.0.0.1:5500",
                                        "*"]}},
     supports_credentials=False,
     allow_headers=["Content-Type", "Authorization"])

app.config['SQLALCHEMY_DATABASE_URI'] = 'sqlite:///ridesphere.db'
app.config['SECRET_KEY'] = 'supersecretkey'
db = SQLAlchemy(app)

# -------------- MODELS --------------
class User(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    email = db.Column(db.String(120), unique=True, nullable=False)
    phone = db.Column(db.String(15), unique=True, nullable=False)
    password = db.Column(db.String(200), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    bookings = db.relationship('Booking', backref='user', lazy=True)

class Route(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    origin = db.Column(db.String(100), nullable=False)
    destination = db.Column(db.String(100), nullable=False)
    schedules = db.relationship('Schedule', backref='route', lazy=True)

class Schedule(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    route_id = db.Column(db.Integer, db.ForeignKey('route.id'), nullable=False)
    bus_name = db.Column(db.String(100), nullable=False)
    departure = db.Column(db.String(50), nullable=False)  # ISO-like string
    seats_available = db.Column(db.Integer, nullable=False)
    bookings = db.relationship('Booking', backref='schedule', lazy=True)
    ratings = db.relationship('Rating', backref='schedule', lazy=True)

class Booking(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    schedule_id = db.Column(db.Integer, db.ForeignKey('schedule.id'), nullable=False)
    seats = db.Column(db.Integer, nullable=False)
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)
    # Soft cancel
    is_cancelled = db.Column(db.Boolean, default=False)
    cancelled_at = db.Column(db.DateTime, nullable=True)
    cancel_reason = db.Column(db.String(300), nullable=True)
    # NEW: store selected seat labels like ["1A","1B"]
    seat_numbers = db.Column(db.Text, nullable=True)  # JSON string

class Rating(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    schedule_id = db.Column(db.Integer, db.ForeignKey('schedule.id'), nullable=False)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=False)
    rating = db.Column(db.Integer, nullable=False)
    comment = db.Column(db.String(500))
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

# NEW: App-wide rating model (for the app rating popup)
class AppRating(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id'), nullable=True)
    rating = db.Column(db.Integer, nullable=False)
    comment = db.Column(db.String(500))
    platform = db.Column(db.String(30))
    created_at = db.Column(db.DateTime, default=datetime.datetime.utcnow)

# -------------- PAYMENT STORE --------------
payment_store = {}

# -------------- AUTH DECORATORS --------------
def token_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        token = None
        if 'Authorization' in request.headers:
            bearer = request.headers['Authorization']
            if bearer.startswith('Bearer '):
                token = bearer.split(' ')[1]
        if not token:
            return jsonify({'error': 'Token is missing'}), 401
        try:
            data = jwt.decode(token, app.config['SECRET_KEY'], algorithms=['HS256'])
            current_user = User.query.get(data['user_id'])
            if not current_user:
                return jsonify({'error': 'User not found'}), 401
        except jwt.ExpiredSignatureError:
            return jsonify({'error': 'Token expired'}), 401
        except Exception:
            return jsonify({'error': 'Invalid token'}), 401
        return f(current_user, *args, **kwargs)
    return decorated

def admin_required(f):
    @token_required
    @wraps(f)
    def decorated(current_user, *args, **kwargs):
        if not current_user.is_admin:
            return jsonify({'error': 'Admin access required'}), 403
        return f(current_user, *args, **kwargs)
    return decorated

# -------------- UTILS --------------
def generate_jwt(user):
    token = jwt.encode({
        'user_id': user.id,
        'exp': datetime.datetime.utcnow() + datetime.timedelta(hours=6)
    }, app.config['SECRET_KEY'], algorithm='HS256')
    if isinstance(token, bytes):
        token = token.decode('utf-8')
    return token

def create_qr_base64(text: str) -> str:
    qr = qrcode.QRCode(version=2, box_size=8, border=2)
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="black", back_color="white")
    buffer = io.BytesIO()
    img.save(buffer, format="PNG")
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode('utf-8')

# Helper: compute reserved seats for a schedule (non-cancelled bookings)
def reserved_seats_for_schedule(schedule_id: int):
    rows = (Booking.query
            .filter(Booking.schedule_id == schedule_id, Booking.is_cancelled == False)
            .all())
    acc = []
    for b in rows:
        if b.seat_numbers:
            try:
                arr = json.loads(b.seat_numbers) if isinstance(b.seat_numbers, str) else b.seat_numbers
                acc.extend([str(x).upper() for x in (arr or [])])
            except Exception:
                pass
    # unique preserve order
    seen = set(); out = []
    for s in acc:
        if s not in seen:
            out.append(s); seen.add(s)
    return out

# -------------- AUTH & USER --------------
@app.route('/api/signup', methods=['POST'])
def signup():
    data = request.get_json() or {}
    email = data.get('email'); phone = data.get('phone'); password = data.get('password')
    if not email or not phone or not password:
        return jsonify({'error': 'Missing fields'}), 400
    if User.query.filter((User.email==email)|(User.phone==phone)).first():
        return jsonify({'error': 'User already exists'}), 400
    hashed = generate_password_hash(password)
    user = User(email=email, phone=phone, password=hashed)
    db.session.add(user)
    db.session.commit()
    return jsonify({'message': 'User created'}), 201

@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    email = data.get('email'); phone = data.get('phone'); password = data.get('password')
    if not email or not phone or not password:
        return jsonify({'error': 'Missing fields'}), 400
    user = User.query.filter_by(email=email, phone=phone).first()
    if not user or not check_password_hash(user.password, password):
        return jsonify({'error': 'Invalid credentials'}), 401
    token = generate_jwt(user)
    is_admin_str = "true" if user.is_admin else "false"
    return jsonify({'message': 'Login successful', 'token': token, 'is_admin': is_admin_str}), 200

@app.route('/api/me', methods=['GET'])
@token_required
def current_user_info(current_user):
    return jsonify({
        'email': current_user.email,
        'is_admin': "true" if current_user.is_admin else "false"
    }), 200

# -------------- ROUTES & SCHEDULES --------------
@app.route('/api/routes', methods=['GET'])
def get_routes():
    routes = Route.query.all()
    return jsonify({'routes':[{'id': r.id, 'name': r.name, 'origin': r.origin, 'destination': r.destination} for r in routes]}), 200

@app.route('/api/schedules', methods=['GET'])
def get_schedules():
    schedules = Schedule.query.all()
    return jsonify({'schedules':[{'id': s.id, 'route_id': s.route_id, 'bus_name': s.bus_name, 'departure': s.departure, 'seats_available': s.seats_available} for s in schedules]}), 200

# -------------- PAYMENT & BOOKING --------------
@app.route('/api/pay', methods=['POST'])
@token_required
def pay(current_user):
    data = request.get_json() or {}
    amount = data.get('amount')
    if amount is None:
        return jsonify({'error': 'Amount required'}), 400
    token = f"pay_{int(datetime.datetime.utcnow().timestamp())}_{current_user.id}"
    payment_store[token] = {'amount': amount, 'status': 'success', 'user_id': current_user.id}
    return jsonify({'status': 'success', 'payment_token': token}), 200

@app.route('/api/book', methods=['POST'])
@token_required
def book(current_user):
    data = request.get_json() or {}
    schedule_id = data.get('schedule_id')
    seats = data.get('seats')
    payment_token = data.get('payment_token')
    seat_numbers = data.get('seat_numbers') or []  # NEW: optional array of labels
    if not schedule_id or not seats or not payment_token:
        return jsonify({'error': 'Missing fields'}), 400

    # Validate payment token
    payment = payment_store.get(payment_token)
    if not payment or payment.get('status') != 'success' or payment.get('user_id') != current_user.id:
        return jsonify({'error': 'Invalid payment token'}), 400

    schedule = Schedule.query.get(schedule_id)
    if not schedule:
        return jsonify({'error': 'Schedule not found'}), 404

    try:
        seats = int(seats)
    except:
        return jsonify({'error': 'Invalid seats'}), 400
    if seats <= 0:
        return jsonify({'error': 'Seats must be > 0'}), 400
    if seats > schedule.seats_available:
        return jsonify({'error': 'Not enough seats available'}), 400

    # Validate seat_numbers if provided
    if isinstance(seat_numbers, list) and len(seat_numbers) > 0:
        # Normalize labels to uppercase strings without spaces
        seat_numbers_norm = [str(s).upper().strip() for s in seat_numbers if str(s).strip()]
        # Duplicates
        if len(seat_numbers_norm) != len(set(seat_numbers_norm)):
            return jsonify({'error': 'Duplicate seat numbers in selection'}), 400
        # Must match count
        if seats != len(seat_numbers_norm):
            return jsonify({'error': 'Seats count does not match selected seat_numbers'}), 400
        # Conflicts with already reserved
        taken = set(reserved_seats_for_schedule(int(schedule_id)))
        conflict = sorted(list(taken.intersection(seat_numbers_norm)))
        if conflict:
            return jsonify({'error': 'Some seats are already reserved', 'conflict': conflict}), 409
        # Use normalized labels
        seat_numbers = seat_numbers_norm
    else:
        seat_numbers = None  # not selecting specific seats

    # Reserve seats
    schedule.seats_available = max(0, schedule.seats_available - seats)
    booking = Booking(
        user_id=current_user.id,
        schedule_id=schedule_id,
        seats=seats,
        seat_numbers=json.dumps(seat_numbers) if seat_numbers else None
    )
    db.session.add(booking)
    db.session.commit()

    qr_payload = {
        'booking_id': booking.id,
        'user_id': current_user.id,
        'schedule_id': schedule_id,
        'seats': seats,
        'seat_numbers': (json.loads(booking.seat_numbers) if booking.seat_numbers else []),
        'timestamp': booking.created_at.isoformat()
    }
    qr_base64 = create_qr_base64(str(qr_payload))
    return jsonify({'message':'Booking successful', 'booking_id': booking.id, 'qr_base64': qr_base64}), 200

@app.route('/api/booking_qr/<int:booking_id>', methods=['GET'])
@token_required
def get_booking_qr(current_user, booking_id):
    booking = Booking.query.get(booking_id)
    if not booking or booking.user_id != current_user.id:
        return jsonify({'error': 'Booking not found'}), 404
    if booking.is_cancelled:
        return jsonify({'error': 'Booking is cancelled'}), 400
    qr_payload = {
        'booking_id': booking.id,
        'user_id': current_user.id,
        'schedule_id': booking.schedule_id,
        'seats': booking.seats,
        'seat_numbers': (json.loads(booking.seat_numbers) if booking.seat_numbers else []),
        'timestamp': booking.created_at.isoformat()
    }
    qr_base64 = create_qr_base64(str(qr_payload))
    return jsonify({'qr_base64': qr_base64}), 200

@app.route('/api/mybookings', methods=['GET'])
@token_required
def mybookings(current_user):
    bookings = Booking.query.filter_by(user_id=current_user.id).order_by(Booking.created_at.desc()).all()
    result = []
    for b in bookings:
        rating_obj = Rating.query.filter_by(user_id=current_user.id, schedule_id=b.schedule_id).first()
        rating_val = rating_obj.rating if rating_obj else None
        result.append({
            'id': b.id,
            'schedule_id': b.schedule_id,
            'seats': b.seats,
            'seat_numbers': (json.loads(b.seat_numbers) if b.seat_numbers else []),  # NEW
            'created_at': b.created_at.isoformat(),
            'is_cancelled': bool(b.is_cancelled),
            'status': 'cancelled' if b.is_cancelled else 'active',
            'rating': rating_val
        })
    return jsonify({'bookings': result}), 200

# -------------- SEAT MAP SUPPORT --------------
# Return reserved seats for a schedule (aliases to match frontend fallbacks)
@app.route('/api/schedules/<int:schedule_id>/seats', methods=['GET'])
def api_seats_primary(schedule_id):
    return jsonify({'reserved': reserved_seats_for_schedule(schedule_id)}), 200

@app.route('/api/schedule/<int:schedule_id>/seats', methods=['GET'])
def api_seats_alias(schedule_id):
    return jsonify({'reserved': reserved_seats_for_schedule(schedule_id)}), 200

@app.route('/api/seats', methods=['GET'])
def api_seats_query():
    sid = request.args.get('schedule_id', type=int)
    if not sid:
        return jsonify({'error': 'schedule_id required'}), 400
    return jsonify({'reserved': reserved_seats_for_schedule(sid)}), 200

# -------------- CANCELLATION (matches dashboard fallbacks) --------------
def cancel_booking_logic(current_user, booking_id, reason=""):
    booking = Booking.query.get(booking_id)
    if not booking or booking.user_id != current_user.id:
        return {'error': 'Booking not found'}, 404
    if booking.is_cancelled:
        return {'message': 'Already cancelled', 'success': True}, 200
    schedule = Schedule.query.get(booking.schedule_id)
    if schedule:
        schedule.seats_available = schedule.seats_available + booking.seats
    booking.is_cancelled = True
    booking.cancelled_at = datetime.datetime.utcnow()
    booking.cancel_reason = (reason or "")[:300] if reason else None
    db.session.commit()
    return {'message': 'Booking cancelled', 'success': True}, 200

@app.route('/api/cancel_booking/<int:booking_id>', methods=['POST'])
@token_required
def cancel_booking_path(current_user, booking_id):
    payload, status = cancel_booking_logic(current_user, booking_id, (request.get_json() or {}).get('reason', ''))
    return jsonify(payload), status

@app.route('/api/bookings/<int:booking_id>', methods=['DELETE'])
@token_required
def cancel_booking_delete(current_user, booking_id):
    payload, status = cancel_booking_logic(current_user, booking_id, "")
    return jsonify(payload), status

@app.route('/api/cancel_booking', methods=['POST'])
@token_required
def cancel_booking_body(current_user):
    data = request.get_json() or {}
    booking_id = data.get('booking_id')
    if not booking_id:
        return jsonify({'error': 'booking_id required'}), 400
    payload, status = cancel_booking_logic(current_user, int(booking_id), data.get('reason', ''))
    return jsonify(payload), status

# -------------- RATINGS (matches dashboard fallbacks) --------------
def save_rating(current_user, booking_id, rating_val, comment=""):
    try:
        rating_int = int(rating_val)
    except:
        return {'error': 'Invalid rating'}, 400
    if rating_int < 1 or rating_int > 5:
        return {'error': 'rating must be 1..5'}, 400

    booking = Booking.query.get(booking_id)
    if not booking or booking.user_id != current_user.id:
        return {'error': 'Booking not found'}, 404
    # Upsert: one rating per user per schedule
    r = Rating.query.filter_by(user_id=current_user.id, schedule_id=booking.schedule_id).first()
    if r:
        r.rating = rating_int
        r.comment = (comment or "")[:500]
    else:
        r = Rating(schedule_id=booking.schedule_id, user_id=current_user.id, rating=rating_int, comment=(comment or "")[:500])
        db.session.add(r)
    db.session.commit()
    return {'message': 'Rating saved'}, 200

@app.route('/api/rate_booking', methods=['POST'])
@token_required
def rate_booking(current_user):
    data = request.get_json() or {}
    booking_id = data.get('booking_id')
    rating_val = data.get('rating')
    comment = data.get('comment', '')
    if not booking_id:
        return jsonify({'error': 'booking_id required'}), 400
    payload, status = save_rating(current_user, int(booking_id), rating_val, comment)
    return jsonify(payload), status

@app.route('/api/bookings/<int:booking_id>/rating', methods=['POST'])
@token_required
def rate_booking_by_booking(current_user, booking_id):
    data = request.get_json() or {}
    rating_val = data.get('rating')
    comment = data.get('comment', '')
    payload, status = save_rating(current_user, int(booking_id), rating_val, comment)
    return jsonify(payload), status

# -------------- APP RATING (for app-wide feedback popup) --------------
def save_app_rating(current_user, rating_val, comment, platform):
    try:
        rating_int = int(rating_val)
    except:
        return {'error': 'Invalid rating'}, 400
    if rating_int < 1 or rating_int > 5:
        return {'error': 'rating must be 1..5'}, 400

    rec = AppRating(
        user_id=(current_user.id if current_user else None),
        rating=rating_int,
        comment=(comment or "")[:500],
        platform=(platform or "web")[:30]
    )
    db.session.add(rec)
    db.session.commit()
    return {'message': 'Thanks for your feedback!'}, 201

@app.route('/api/app_rating', methods=['POST'])
@token_required
def app_rating(current_user):
    data = request.get_json() or {}
    rating = data.get('rating')
    comment = data.get('comment', '')
    platform = data.get('platform', 'web')
    payload, status = save_app_rating(current_user, rating, comment, platform)
    return jsonify(payload), status

# Fallback alias used by frontend if /app_rating is unavailable
@app.route('/api/feedback', methods=['POST'])
@token_required
def app_feedback(current_user):
    data = request.get_json() or {}
    rating = data.get('rating')
    comment = data.get('comment', '')
    platform = data.get('platform', 'web')
    payload, status = save_app_rating(current_user, rating, comment, platform)
    return jsonify(payload), status

# -------------- ADMIN ROUTES --------------
@app.route('/api/admin/add_route', methods=['POST'])
@admin_required
def admin_add_route(current_user):
    data = request.get_json() or {}
    name = data.get('name'); origin = data.get('origin'); destination = data.get('destination')
    if not name or not origin or not destination:
        return jsonify({'error': 'Missing fields'}), 400
    r = Route(name=name, origin=origin, destination=destination)
    db.session.add(r); db.session.commit()
    return jsonify({'message': 'Route added', 'route_id': r.id}), 201

@app.route('/api/admin/update_route/<int:id>', methods=['PUT'])
@admin_required
def admin_update_route(current_user, id):
    route = Route.query.get(id)
    if not route:
        return jsonify({'error':'Route not found'}),404
    data = request.get_json() or {}
    route.name = data.get('name', route.name)
    route.origin = data.get('origin', route.origin)
    route.destination = data.get('destination', route.destination)
    db.session.commit()
    return jsonify({'message':'Route updated'}),200

@app.route('/api/admin/delete_route/<int:id>', methods=['DELETE'])
@admin_required
def admin_delete_route(current_user, id):
    route = Route.query.get(id)
    if not route:
        return jsonify({'error':'Route not found'}),404
    db.session.delete(route)
    db.session.commit()
    return jsonify({'message':'Route deleted'}),200

@app.route('/api/admin/add_schedule', methods=['POST'])
@admin_required
def admin_add_schedule(current_user):
    data = request.get_json() or {}
    route_id = data.get('route_id'); bus_name = data.get('bus_name'); departure = data.get('departure'); seats_available = data.get('seats_available', 40)
    if not route_id or not bus_name or not departure:
        return jsonify({'error': 'Missing fields'}), 400
    schedule = Schedule(route_id=route_id, bus_name=bus_name, departure=departure, seats_available=int(seats_available))
    db.session.add(schedule); db.session.commit()
    return jsonify({'message': 'Schedule added', 'schedule_id': schedule.id}), 201

@app.route('/api/admin/update_schedule/<int:id>', methods=['PUT'])
@admin_required
def admin_update_schedule(current_user, id):
    schedule = Schedule.query.get(id)
    if not schedule:
        return jsonify({'error':'Schedule not found'}),404
    data = request.get_json() or {}
    schedule.route_id = data.get('route_id', schedule.route_id)
    schedule.bus_name = data.get('bus_name', schedule.bus_name)
    schedule.departure = data.get('departure', schedule.departure)
    schedule.seats_available = data.get('seats_available', schedule.seats_available)
    db.session.commit()
    return jsonify({'message':'Schedule updated'}),200

@app.route('/api/admin/delete_schedule/<int:id>', methods=['DELETE'])
@admin_required
def admin_delete_schedule(current_user, id):
    schedule = Schedule.query.get(id)
    if not schedule:
        return jsonify({'error':'Schedule not found'}),404
    db.session.delete(schedule)
    db.session.commit()
    return jsonify({'message':'Schedule deleted'}),200

# -------------- HEALTH --------------
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok'}), 200

# -------------- INIT DB & DEFAULT ADMIN --------------
def ensure_booking_columns():
    # Adds new columns if DB already existed (SQLite only)
    try:
        inspector = inspect(db.engine)
        cols = {c['name'] for c in inspector.get_columns('booking')}
        altered = False
        if 'is_cancelled' not in cols:
            db.session.execute(text("ALTER TABLE booking ADD COLUMN is_cancelled BOOLEAN DEFAULT 0"))
            altered = True
        if 'cancelled_at' not in cols:
            db.session.execute(text("ALTER TABLE booking ADD COLUMN cancelled_at DATETIME"))
            altered = True
        if 'cancel_reason' not in cols:
            db.session.execute(text("ALTER TABLE booking ADD COLUMN cancel_reason VARCHAR(300)"))
            altered = True
        # NEW: seat_numbers column to store JSON of selected seats
        if 'seat_numbers' not in cols:
            db.session.execute(text("ALTER TABLE booking ADD COLUMN seat_numbers TEXT"))
            altered = True
        if altered:
            db.session.commit()
    except Exception:
        # Fresh DB or SQLite limitation on complex alter; safe to ignore
        pass

if __name__ == '__main__':
    with app.app_context():
        db.create_all()       # creates AppRating table if not present
        ensure_booking_columns()
        if not User.query.filter_by(email='sagarmanjupatil@gmail.com').first():
            admin = User(
                email='sagarmanjupatil@gmail.com',
                phone='7676993602',
                password=generate_password_hash('SAGAR@123'),
                is_admin=True
            )
            db.session.add(admin)
            db.session.commit()
    app.run(debug=True)
